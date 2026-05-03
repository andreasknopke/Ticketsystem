require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const multer = require('multer');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(checkHash, 'hex'));
}

function parseCheckbox(value) {
    return value === 'on' || value === '1' || value === 1 ? 1 : 0;
}
const nodemailer = require('nodemailer');
const http = require('http');
const { Server } = require('socket.io');
const { marked } = require('marked');
const { Octokit } = require('@octokit/rest');
const aiClient = require('./services/ai/client');
const redactor = require('./services/ai/redact');
const workflowEngine = require('./services/workflow/engine');
const dossierExport = require('./services/workflow/dossierExport');
const {
    EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN,
    EXTERNAL_DISPATCH_PROMPT_TEMPLATE,
    buildExternalDispatchPrompt
} = require('./services/workflow/externalDispatchPrompt');

if (process.env.AI_REDACTION_PATTERNS_FILE) {
    redactor.loadExtraPatternsFromFile(process.env.AI_REDACTION_PATTERNS_FILE);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 8010;
const BASE_URL = process.env.BASE_URL || 'http://localhost:' + PORT;
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, 'tickets.db');

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:8010', 'http://localhost:3000', 'http://localhost:5173'];

function normalizeOrigin(value) {
    if (!value) return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

const configuredAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => normalizeOrigin(origin.trim()))
    .filter(Boolean);

const configuredApiAllowedIps = (process.env.API_ALLOWED_IPS || '')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);

const allowedOrigins = new Set(
    [...DEFAULT_ALLOWED_ORIGINS, BASE_URL, ...configuredAllowedOrigins]
        .map(normalizeOrigin)
        .filter(Boolean)
);

const APP_SECRET = process.env.APP_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const API_KEY = process.env.API_KEY;
const REQUIRE_API_KEY = (process.env.REQUIRE_API_KEY || 'false').toLowerCase() === 'true';
const TRUST_PROXY = (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';

// SLA Konfiguration (in Stunden)
const SLA_CONFIG = {
    first_response: {
        kritisch: 1,
        hoch: 4,
        mittel: 8,
        niedrig: 24
    },
    resolution: {
        kritisch: 4,
        hoch: 24,
        mittel: 72,
        niedrig: 168
    }
};

// E-Mail Konfiguration
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME;

const EMAIL_NOTIFY_NEW = (process.env.EMAIL_NOTIFY_NEW || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_STATUS = (process.env.EMAIL_NOTIFY_STATUS || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_ASSIGN = (process.env.EMAIL_NOTIFY_ASSIGN || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_COMMENT = (process.env.EMAIL_NOTIFY_COMMENT || 'true').toLowerCase() === 'true';
const MILESTONE_STEP_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const MILESTONE_STEP_MAX_FILES = 5;

if (!APP_SECRET || ADMIN_USER === undefined || ADMIN_PASS === undefined) {
    console.error('FEHLER: APP_SECRET, ADMIN_USER und ADMIN_PASS muessen in der .env Datei gesetzt sein!');
    process.exit(1);
}

const USE_SECURE_COOKIE = BASE_URL.startsWith('https://');
if (TRUST_PROXY || USE_SECURE_COOKIE) app.set('trust proxy', 1);

const milestoneStepUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MILESTONE_STEP_MAX_ATTACHMENT_SIZE_BYTES,
        files: MILESTONE_STEP_MAX_FILES
    }
});

function handleMilestoneStepUpload(req, res, next) {
    milestoneStepUpload.array('attachments', MILESTONE_STEP_MAX_FILES)(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `Anhaenge duerfen maximal ${MILESTONE_STEP_MAX_ATTACHMENT_SIZE_BYTES} Bytes gross sein.` });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: `Maximal ${MILESTONE_STEP_MAX_FILES} Anhaenge pro Schritt erlaubt.` });
        }
        return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen.' });
    });
}

function clientIp(req) {
    return (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
}

function createRateLimiter({ windowMs, max, message }) {
    const attempts = new Map();

    return (req, res, next) => {
        const key = clientIp(req);
        const now = Date.now();
        const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };

        if (entry.resetAt <= now) {
            entry.count = 0;
            entry.resetAt = now + windowMs;
        }

        entry.count += 1;
        attempts.set(key, entry);

        if (entry.count > max) {
            if (req.path.startsWith('/api/')) return res.status(429).json({ error: message });
            return res.status(429).send(message);
        }

        next();
    };
}

const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.'
});

const publicTicketApiRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Zu viele API-Anfragen. Bitte später erneut versuchen.'
});

function requireApiAllowedIp(req, res, next) {
    if (configuredApiAllowedIps.length === 0) return next();
    if (configuredApiAllowedIps.includes(clientIp(req))) return next();
    res.status(403).json({ error: 'IP-Adresse nicht für die Ticket-API freigegeben.' });
}

// Middleware
// GitHub Webhook MUST be before express.json() to get raw body for HMAC verification
app.post('/api/github/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    let body;
    try { body = JSON.parse(req.body.toString('utf-8')); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const event = req.headers['x-github-event'];

    if (signature && body.repository) {
        const [owner, repo] = body.repository.full_name.split('/');
        db.get('SELECT * FROM github_integration WHERE repo_owner = ? AND repo_name = ?', [owner, repo], (err, integration) => {
            if (integration && integration.webhook_secret) {
                const hmac = crypto.createHmac('sha256', integration.webhook_secret);
                hmac.update(req.body);
                const expectedSig = 'sha256=' + hmac.digest('hex');
                try {
                    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
                        return res.status(401).json({ error: 'Invalid signature' });
                    }
                } catch(e) {
                    return res.status(401).json({ error: 'Invalid signature' });
                }
            }

            if (event === 'issues' && body.action === 'opened' && body.issue && !body.issue.pull_request) {
                const i = body.issue;
                db.run(`INSERT OR REPLACE INTO github_issues (project_id, issue_number, title, state, html_url, labels, github_created_at, github_updated_at, github_user, synced_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [integration.project_id, i.number, i.title, i.state, i.html_url,
                     JSON.stringify(i.labels.map(l => l.name)), i.created_at, i.updated_at, i.user?.login]);
                io.emit('github:issue_opened', { projectId: integration.project_id, issue: i });
            } else if (event === 'issues' && body.action === 'closed' && body.issue) {
                const i = body.issue;
                db.run(`INSERT OR REPLACE INTO github_issues (project_id, issue_number, title, state, html_url, labels, github_created_at, github_updated_at, github_user, synced_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [integration.project_id, i.number, i.title, i.state, i.html_url,
                     JSON.stringify(i.labels.map(l => l.name)), i.created_at, i.updated_at, i.user?.login]);
                io.emit('github:issue_closed', { projectId: integration.project_id, issue: i });
            }

            res.status(200).json({ status: 'processed', event });
        });
    } else {
        res.status(200).json({ status: 'received_no_repo' });
    }
});

app.use('/api', (req, res, next) => {
    const requestOrigin = normalizeOrigin(req.headers.origin);

    if (requestOrigin && allowedOrigins.has(requestOrigin)) {
        res.header('Access-Control-Allow-Origin', requestOrigin);
        res.header('Vary', 'Origin');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        res.header('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
        if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
            return res.status(403).json({ error: 'Origin nicht erlaubt.' });
        }
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

app.use(session({
    secret: APP_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        sameSite: 'lax',
        secure: USE_SECURE_COOKIE
    }
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }

    res.locals.csrfToken = req.session.csrfToken;

    const methodRequiresCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!methodRequiresCsrf || req.path.startsWith('/api/')) return next();

    const token = req.body._csrf || req.headers['x-csrf-token'];
    if (token !== req.session.csrfToken) {
        return res.status(403).send('Ungültiger oder fehlender CSRF-Token.');
    }

    next();
});

// Hilfsfunktionen fuer EJS
app.locals.toTitle = (str) => {
    if (!str) return '';
    return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
};

app.locals.formatDateTime = (value) => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('de-DE');
};

app.locals.formatRelativeTime = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    const now = new Date();
    const diffMs = date - now;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 0) return 'Überfällig';
    if (diffMins < 60) return `${diffMins} Min.`;
    if (diffHours < 24) return `${diffHours} Std.`;
    return `${diffDays} Tage`;
};

// --- Auth Middlewares ---

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Nicht authentifiziert.' });
    }
    res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.authenticated && (req.session.role === 'admin' || req.session.role === 'root')) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Keine Berechtigung.' });
    }
    res.status(403).send('Keine Berechtigung.');
}

function requireRoot(req, res, next) {
    if (req.session && req.session.authenticated && req.session.role === 'root') {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Nur root-Benutzer haben Zugriff.' });
    }
    res.status(403).send('Nur root-Benutzer haben Zugriff.');
}

function isAdminRole(role) {
    return role === 'admin' || role === 'root';
}

function canManageTickets(req) {
    return req.session && req.session.authenticated && isAdminRole(req.session.role);
}

function canViewTicket(req, ticket) {
    if (!ticket || !req.session || !req.session.authenticated) return false;
    if (isAdminRole(req.session.role)) return true;
    if (req.session.staff_id && Number(ticket.assigned_to) === Number(req.session.staff_id)) return true;
    return ticket.username && ticket.username === req.session.user;
}

function ticketVisibilityClause(req, alias = 't') {
    if (isAdminRole(req.session.role)) return { clause: '', params: [] };

    const conditions = [`${alias}.username = ?`];
    const params = [req.session.user];
    if (req.session.staff_id) {
        conditions.push(`${alias}.assigned_to = ?`);
        params.push(req.session.staff_id);
    }

    return { clause: ` AND (${conditions.join(' OR ')})`, params };
}

function normalizeText(value, maxLength) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.slice(0, maxLength);
}

function parseGithubRepoReference(...values) {
    const raw = values.map(v => normalizeText(v || '', 300)).find(Boolean) || '';
    if (!raw) return { owner: null, name: null };
    const cleaned = raw.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '').trim();
    const urlMatch = cleaned.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:[/?#].*)?$/i);
    if (urlMatch) return { owner: urlMatch[1], name: urlMatch[2].replace(/\.git$/i, '') };
    const shortMatch = cleaned.match(/^([^/\s]+)\/([^/\s#?]+)$/);
    if (shortMatch) return { owner: shortMatch[1], name: shortMatch[2].replace(/\.git$/i, '') };
    return { owner: null, name: null };
}

function loadCurrentUserAccount(req, callback) {
    if (!req.session || !req.session.authenticated || !req.session.user) {
        return callback(null, null);
    }

    db.get(`SELECT u.id, u.username, u.role, u.staff_id, u.default_system_id,
            u.notify_new_tickets, u.notify_assigned_tickets, u.notify_status_changes,
            s.name AS staff_name, s.email AS staff_email,
            sys.name AS system_name
        FROM users u
        LEFT JOIN staff s ON u.staff_id = s.id
        LEFT JOIN systems sys ON u.default_system_id = sys.id
        WHERE u.username = ? AND u.active = 1`,
    [req.session.user], callback);
}

function requireApiKey(req, res, next) {
    if (!REQUIRE_API_KEY) return next();
    const key = req.headers['x-api-key'];
    if (!API_KEY) {
        console.warn('WARNUNG: REQUIRE_API_KEY ist true, aber API_KEY ist nicht gesetzt!');
        return next();
    }
    if (key === API_KEY) return next();
    res.status(403).json({ error: 'Ungueltiger oder fehlender API-Key (Header: x-api-key).' });
}

// --- Datenbank ---

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) { console.error('DB Error:', err.message); }
    else { console.log('Connected to SQLite DB.'); }
});

// Tabellen erstellen
function initDb() {
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER,
        user TEXT,
        action TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        repo_owner TEXT,
        repo_name TEXT,
        repo_access_token TEXT,
        repo_webhook_secret TEXT,
        active INTEGER DEFAULT 1
    )`, (err) => {
        if (err) {
            console.error('Systems table error:', err.message);
            return;
        }
        db.all("PRAGMA table_info(systems)", (pragmaErr, rows) => {
            if (pragmaErr) return;
            const cols = rows.map(r => r.name);
            if (!cols.includes('ai_workflow_enabled')) {
                db.run('ALTER TABLE systems ADD COLUMN ai_workflow_enabled INTEGER DEFAULT 1', (e) => {
                    if (e) console.error('Fehler beim Hinzufuegen von systems.ai_workflow_enabled:', e.message);
                });
            }
            const systemMigrations = [
                { col: 'repo_owner', sql: 'ALTER TABLE systems ADD COLUMN repo_owner TEXT' },
                { col: 'repo_name', sql: 'ALTER TABLE systems ADD COLUMN repo_name TEXT' },
                { col: 'repo_access_token', sql: 'ALTER TABLE systems ADD COLUMN repo_access_token TEXT' },
                { col: 'repo_webhook_secret', sql: 'ALTER TABLE systems ADD COLUMN repo_webhook_secret TEXT' }
            ];
            systemMigrations.forEach(m => {
                if (!cols.includes(m.col)) {
                    db.run(m.sql, (e) => {
                        if (e) console.error(`Fehler beim Hinzufuegen von systems.${m.col}:`, e.message);
                    });
                }
            });
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        active INTEGER DEFAULT 1
    )`, (err) => {
        if (err) {
            console.error('Staff table error:', err.message);
            return;
        }
        db.all("PRAGMA table_info(staff)", (pragmaErr, rows) => {
            if (pragmaErr) {
                console.error('Fehler beim Pruefen der staff-Tabelle:', pragmaErr.message);
                return;
            }
            const cols = rows.map(r => r.name);
            const staffMigrations = [
                { col: 'kind', sql: "ALTER TABLE staff ADD COLUMN kind TEXT DEFAULT 'human'" },
                { col: 'ai_provider', sql: 'ALTER TABLE staff ADD COLUMN ai_provider TEXT' },
                { col: 'ai_model', sql: 'ALTER TABLE staff ADD COLUMN ai_model TEXT' },
                { col: 'ai_temperature', sql: 'ALTER TABLE staff ADD COLUMN ai_temperature REAL DEFAULT 0.2' },
                { col: 'ai_system_prompt', sql: 'ALTER TABLE staff ADD COLUMN ai_system_prompt TEXT' },
                { col: 'ai_max_tokens', sql: 'ALTER TABLE staff ADD COLUMN ai_max_tokens INTEGER' },
                { col: 'ai_extra_config', sql: 'ALTER TABLE staff ADD COLUMN ai_extra_config TEXT' },
                { col: 'coding_level', sql: "ALTER TABLE staff ADD COLUMN coding_level TEXT" },
                { col: 'auto_commit_enabled', sql: 'ALTER TABLE staff ADD COLUMN auto_commit_enabled INTEGER DEFAULT 0' }
            ];
            staffMigrations.forEach(m => {
                if (!cols.includes(m.col)) {
                    db.run(m.sql, (e) => {
                        if (e) {
                            console.error(`Fehler beim Hinzufuegen von staff.${m.col}:`, e.message);
                            return;
                        }
                        if (m.col === 'kind') {
                            db.run("UPDATE staff SET kind = 'human' WHERE kind IS NULL OR kind = ''");
                        }
                    });
                }
            });

            if (cols.includes('kind')) {
                db.run("UPDATE staff SET kind = 'human' WHERE kind IS NULL OR kind = ''");
            }
            if (cols.includes('ai_provider') && cols.includes('ai_model')) {
                db.run(`UPDATE staff SET ai_model = 'gpt-oss:120b'
                    WHERE ai_provider = 'ollama'
                      AND (ai_model IS NULL OR ai_model = '' OR ai_model IN ('llama3.1', 'gemma3:12b', 'gemma3:12b-cloud'))`, (e) => {
                    if (e) console.error('Fehler beim Aktualisieren alter Ollama-Modelle:', e.message);
                });
            }
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS ticket_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        author TEXT,
        text TEXT NOT NULL,
        is_internal INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);

    // SLA Tracking
    db.run(`CREATE TABLE IF NOT EXISTS ticket_sla (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL UNIQUE,
        first_response_due DATETIME,
        first_response_at DATETIME,
        resolution_due DATETIME,
        resolution_at DATETIME,
        first_response_breached INTEGER DEFAULT 0,
        resolution_breached INTEGER DEFAULT 0,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);

    // Feedback
    db.run(`CREATE TABLE IF NOT EXISTS ticket_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL UNIQUE,
        rating INTEGER CHECK(rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);

    // Ticket Templates
    db.run(`CREATE TABLE IF NOT EXISTS ticket_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT CHECK(type IN ('bug', 'feature')) DEFAULT 'bug',
        description TEXT,
        fields TEXT,
        active INTEGER DEFAULT 1
    )`);

    // Activity Stream
    db.run(`CREATE TABLE IF NOT EXISTS activity_stream (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        actor TEXT,
        action_type TEXT,
        action_text TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);

    // Projektmanagement
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT CHECK(status IN ('planning','active','maintenance','completed')) DEFAULT 'planning',
        start_date TEXT,
        end_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS project_milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        phase INTEGER CHECK(phase IN (1,2,3)),
        start_date TEXT,
        end_date TEXT,
        status TEXT CHECK(status IN ('pending','in_progress','completed','blocked')) DEFAULT 'pending',
        color TEXT DEFAULT '#2563eb',
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS milestone_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            milestone_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            date TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (milestone_id) REFERENCES project_milestones(id) ON DELETE CASCADE
        )`, (err) => {
            if (err) {
                console.error('Milestone steps table error:', err.message);
                return;
            }
            db.all('PRAGMA table_info(milestone_steps)', (pragmaErr, rows) => {
                if (pragmaErr) {
                    console.error('Fehler beim Pruefen der milestone_steps-Tabelle:', pragmaErr.message);
                    return;
                }
                const cols = rows.map((row) => row.name);
                if (!cols.includes('title')) {
                    db.run("ALTER TABLE milestone_steps ADD COLUMN title TEXT DEFAULT ''", (alterErr) => {
                        if (alterErr) {
                            console.error('Fehler beim Hinzufuegen von milestone_steps.title:', alterErr.message);
                            return;
                        }
                        db.run(`UPDATE milestone_steps
                            SET title = substr(trim(COALESCE(text, '')), 1, 80)
                            WHERE trim(COALESCE(title, '')) = ''`);
                    });
                    return;
                }
                db.run(`UPDATE milestone_steps
                    SET title = substr(trim(COALESCE(text, '')), 1, 80)
                    WHERE trim(COALESCE(title, '')) = ''`);
            });
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_milestone_steps_milestone_id ON milestone_steps(milestone_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_milestone_steps_date ON milestone_steps(date)`);

        db.run(`CREATE TABLE IF NOT EXISTS blobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            step_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            mimetype TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            checksum TEXT,
            data BLOB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE INDEX IF NOT EXISTS idx_blobs_step_id ON blobs(step_id)`);
    });

    db.run(`CREATE TABLE IF NOT EXISTS project_key_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        staff_id INTEGER NOT NULL,
        role TEXT CHECK(role IN ('key_user','evaluator','decision_maker')) DEFAULT 'key_user',
        notes TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS project_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        content TEXT,
        updated_by TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(project_id, slug)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS github_integration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL UNIQUE,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        access_token TEXT,
        webhook_secret TEXT,
        sync_issues INTEGER DEFAULT 1,
        sync_wiki INTEGER DEFAULT 0,
        last_synced_at DATETIME,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS github_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        issue_number INTEGER NOT NULL,
        title TEXT,
        state TEXT,
        html_url TEXT,
        labels TEXT,
        github_created_at DATETIME,
        github_updated_at DATETIME,
        github_user TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(project_id, issue_number)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ticket_pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        ticket_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        UNIQUE(username, ticket_id)
    )`);

    // Bestehende Tabellen-Spalten aktualisieren (Migrationen)
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT CHECK(role IN ('root','admin','user')) DEFAULT 'user',
        staff_id INTEGER,
        default_system_id INTEGER,
        notify_new_tickets INTEGER DEFAULT 0,
        notify_assigned_tickets INTEGER DEFAULT 1,
        notify_status_changes INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (staff_id) REFERENCES staff(id),
        FOREIGN KEY (default_system_id) REFERENCES systems(id)
    )`, (err) => { if (err) console.error('Users table error:', err.message); });

    db.all("PRAGMA table_info(users)", (err, rows) => {
        if (err) {
            console.error('Fehler beim Pruefen der User-Tabelle:', err.message);
            return;
        }
        const userColumns = rows.map(r => r.name);
        const userMigrations = [
            { col: 'notify_new_tickets', sql: 'ALTER TABLE users ADD COLUMN notify_new_tickets INTEGER DEFAULT 0' },
            { col: 'notify_assigned_tickets', sql: 'ALTER TABLE users ADD COLUMN notify_assigned_tickets INTEGER DEFAULT 1' },
            { col: 'notify_status_changes', sql: 'ALTER TABLE users ADD COLUMN notify_status_changes INTEGER DEFAULT 1' }
        ];

        userMigrations.forEach(m => {
            if (!userColumns.includes(m.col)) {
                db.run(m.sql, (migrationError) => {
                    if (migrationError) console.error(`Fehler beim Hinzufuegen von ${m.col}:`, migrationError.message);
                });
            }
        });
    });

    db.all("PRAGMA table_info(tickets)", (err, rows) => {
        if (err) {
            console.error('Fehler beim Pruefen der Tabellenstruktur:', err.message);
            return;
        }
        const columns = rows.map(r => r.name);

        const migrations = [
            { col: 'system_id', sql: 'ALTER TABLE tickets ADD COLUMN system_id INTEGER' },
            { col: 'assigned_to', sql: 'ALTER TABLE tickets ADD COLUMN assigned_to INTEGER' },
            { col: 'location', sql: 'ALTER TABLE tickets ADD COLUMN location TEXT' },
            { col: 'contact_email', sql: 'ALTER TABLE tickets ADD COLUMN contact_email TEXT' },
            { col: 'urgency', sql: `ALTER TABLE tickets ADD COLUMN urgency TEXT CHECK(urgency IN ('normal','emergency','safety')) DEFAULT 'normal'` },
            { col: 'deadline', sql: 'ALTER TABLE tickets ADD COLUMN deadline DATETIME' },
            { col: 'first_responded_at', sql: 'ALTER TABLE tickets ADD COLUMN first_responded_at DATETIME' },
            { col: 'closed_at', sql: 'ALTER TABLE tickets ADD COLUMN closed_at DATETIME' },
            { col: 'feedback_requested', sql: 'ALTER TABLE tickets ADD COLUMN feedback_requested INTEGER DEFAULT 0' },
            { col: 'workflow_run_id', sql: 'ALTER TABLE tickets ADD COLUMN workflow_run_id INTEGER' },
            { col: 'redacted_description', sql: 'ALTER TABLE tickets ADD COLUMN redacted_description TEXT' },
            { col: 'coding_prompt', sql: 'ALTER TABLE tickets ADD COLUMN coding_prompt TEXT' },
            { col: 'implementation_plan', sql: 'ALTER TABLE tickets ADD COLUMN implementation_plan TEXT' },
            { col: 'integration_assessment', sql: 'ALTER TABLE tickets ADD COLUMN integration_assessment TEXT' },
            { col: 'merge_review', sql: 'ALTER TABLE tickets ADD COLUMN merge_review TEXT' },
            { col: 'reference_repo_owner', sql: 'ALTER TABLE tickets ADD COLUMN reference_repo_owner TEXT' },
            { col: 'reference_repo_name', sql: 'ALTER TABLE tickets ADD COLUMN reference_repo_name TEXT' },
            { col: 'final_decision', sql: "ALTER TABLE tickets ADD COLUMN final_decision TEXT" }
        ];

        migrations.forEach(m => {
            if (!columns.includes(m.col)) {
                db.run(m.sql, (e) => {
                    if (e) console.error(`Fehler beim Hinzufuegen von ${m.col}:`, e.message);
                });
            }
        });
    });

    // Migration: tickets.status CHECK-Constraint um 'umgesetzt' erweitern.
    // SQLite kann CHECK-Constraints nicht per ALTER aendern -> Tabelle muss
    // bei alten DBs neu gebaut werden. Wir erkennen das an der CREATE-DDL
    // in sqlite_master und springen sonst raus.
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'", (sqlErr, row) => {
        if (sqlErr || !row || !row.sql) return;
        if (row.sql.includes("'umgesetzt'")) return; // schon migriert / fresh DB
        if (!/status TEXT CHECK\(status IN/.test(row.sql)) return; // unerwartetes Schema, Hand wegnehmen
        console.log('[migration] tickets.status CHECK erweitern (umgesetzt)…');
        db.serialize(() => {
            db.run('DROP TABLE IF EXISTS tickets__new');
            db.run('PRAGMA foreign_keys=OFF');
            db.run('BEGIN TRANSACTION');
            const newDdl = row.sql.replace(
                /status TEXT CHECK\(status IN \(([^)]*)\)\) DEFAULT 'offen'/,
                "status TEXT CHECK(status IN ('offen', 'in_bearbeitung', 'wartend', 'umgesetzt', 'geschlossen')) DEFAULT 'offen'"
            ).replace(/CREATE\s+TABLE\s+["']?tickets["']?/i, 'CREATE TABLE tickets__new');
            db.run(newDdl, (e1) => {
                if (e1) {
                    console.error('[migration] CREATE tickets__new fehlgeschlagen:', e1.message);
                    db.run('ROLLBACK');
                    db.run('PRAGMA foreign_keys=ON');
                    return;
                }
                db.all('PRAGMA table_info(tickets)', (e2, cols) => {
                    if (e2) {
                        console.error('[migration] PRAGMA fehlgeschlagen:', e2.message);
                        db.run('ROLLBACK');
                        db.run('PRAGMA foreign_keys=ON');
                        return;
                    }
                    const colList = cols.map(c => c.name).join(', ');
                    db.run(`INSERT INTO tickets__new (${colList}) SELECT ${colList} FROM tickets`, (e3) => {
                        if (e3) {
                            console.error('[migration] Datenkopie fehlgeschlagen:', e3.message);
                            db.run('ROLLBACK');
                            db.run('PRAGMA foreign_keys=ON');
                            return;
                        }
                        db.run('DROP TABLE tickets', (e4) => {
                            if (e4) { console.error('[migration] DROP fehlgeschlagen:', e4.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                            db.run('ALTER TABLE tickets__new RENAME TO tickets', (e5) => {
                                if (e5) { console.error('[migration] RENAME fehlgeschlagen:', e5.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                                db.run('COMMIT', () => {
                                    db.run('PRAGMA foreign_keys=ON');
                                    console.log('[migration] tickets.status erfolgreich erweitert');
                                });
                            });
                        });
                    });
                });
            });
        });
    });

    // Migration: tickets.status CHECK-Constraint um 'überprüft' erweitern.
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'", (sqlErr, row) => {
        if (sqlErr || !row || !row.sql) return;
        if (row.sql.includes("'überprüft'")) return;
        if (!/status TEXT CHECK\(status IN/.test(row.sql)) return;
        console.log('[migration] tickets.status CHECK erweitern (überprüft)…');
        console.log('[migration] DDL preview:', row.sql.replace(/\n/g, ' ').substring(0, 200));
        db.serialize(() => {
            db.run('DROP TABLE IF EXISTS tickets__new');
            db.run('PRAGMA foreign_keys=OFF');
            db.run('BEGIN TRANSACTION');
            const newDdl = row.sql.replace(
                /status TEXT CHECK\(status IN \(([^)]*)\)\) DEFAULT 'offen'/,
                "status TEXT CHECK(status IN ('offen', 'in_bearbeitung', 'wartend', 'umgesetzt', 'geschlossen', 'überprüft')) DEFAULT 'offen'"
            ).replace(/CREATE\s+TABLE\s+["']?tickets["']?/i, 'CREATE TABLE tickets__new');
            console.log('[migration] newDdl starts with:', newDdl.substring(0, 80));
            db.run(newDdl, (e1) => {
                if (e1) { console.error('[migration] CREATE tickets__new fehlgeschlagen:', e1.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                db.all('PRAGMA table_info(tickets)', (e2, cols) => {
                    if (e2) { console.error('[migration] PRAGMA fehlgeschlagen:', e2.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                    const colList = cols.map(c => c.name).join(', ');
                    db.run(`INSERT INTO tickets__new (${colList}) SELECT ${colList} FROM tickets`, (e3) => {
                        if (e3) { console.error('[migration] Datenkopie fehlgeschlagen:', e3.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                        db.run('DROP TABLE tickets', (e4) => {
                            if (e4) { console.error('[migration] DROP fehlgeschlagen:', e4.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                            db.run('ALTER TABLE tickets__new RENAME TO tickets', (e5) => {
                                if (e5) { console.error('[migration] RENAME fehlgeschlagen:', e5.message); db.run('ROLLBACK'); db.run('PRAGMA foreign_keys=ON'); return; }
                                db.run('COMMIT', () => {
                                    db.run('PRAGMA foreign_keys=ON');
                                    console.log('[migration] tickets.status erfolgreich erweitert (überprüft)');
                                });
                            });
                        });
                    });
                });
            });
        });
    });

    // --- KI-Workflow: Erweiterungen Mitarbeiter & Systeme ---

    // n:m Mitarbeiter <-> Workflow-Rollen
    db.run(`CREATE TABLE IF NOT EXISTS staff_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('triage','security','planning','integration','approval','coding','clarifier')),
        priority INTEGER DEFAULT 100,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(staff_id, role),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    )`, (err) => {
        if (err) {
            console.error('Fehler beim Erstellen staff_roles:', err.message);
            return;
        }
        // Einmalige Migration: Nur Mitarbeiter, die NOCH GAR KEINE Rolle besitzen,
        // bekommen 'approval' als Default. Sonst würden manuell entfernte Rollen
        // bei jedem Serverstart wieder angelegt.
        db.run(`INSERT OR IGNORE INTO staff_roles (staff_id, role, priority, active)
                SELECT s.id, 'approval', 100, 1 FROM staff s
                WHERE s.active = 1
                  AND NOT EXISTS (SELECT 1 FROM staff_roles r WHERE r.staff_id = s.id)`);
    });

    db.run(`CREATE TABLE IF NOT EXISTS staff_system_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id INTEGER NOT NULL,
        system_id INTEGER NOT NULL,
        is_primary INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(staff_id, system_id),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
        FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    )`, (err) => {
        if (err) console.error('Fehler beim Erstellen staff_system_assignments:', err.message);
    });

    // Workflow-Definitionen
    db.run(`CREATE TABLE IF NOT EXISTS workflow_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        is_default INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS workflow_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('triage','security','planning','integration','approval','coding','clarifier')),
        executor_kind TEXT CHECK(executor_kind IN ('ai','human','any')) DEFAULT 'any',
        auto_assign_strategy TEXT CHECK(auto_assign_strategy IN ('round_robin','least_loaded','fixed')) DEFAULT 'round_robin',
        fixed_staff_id INTEGER,
        FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE,
        FOREIGN KEY (fixed_staff_id) REFERENCES staff(id) ON DELETE SET NULL,
        UNIQUE(workflow_id, sort_order)
    )`, (err) => {
        if (err) {
            console.error('Fehler beim Erstellen workflow_stages:', err.message);
            return;
        }
        seedDefaultWorkflow();
    });

    // Round-Robin-Cursor pro Rolle
    db.run(`CREATE TABLE IF NOT EXISTS workflow_role_cursor (
        role TEXT PRIMARY KEY,
        last_staff_id INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Workflow-Runs pro Ticket
    db.run(`CREATE TABLE IF NOT EXISTS ticket_workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        workflow_id INTEGER,
        status TEXT CHECK(status IN ('pending','running','waiting_human','completed','failed','rejected')) DEFAULT 'pending',
        current_stage TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        result TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id) ON DELETE SET NULL
    )`);

    // Einzelne Stage-Ausfuehrungen
    db.run(`CREATE TABLE IF NOT EXISTS ticket_workflow_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('triage','security','planning','integration','approval','coding','clarifier')),
        sort_order INTEGER NOT NULL,
        staff_id INTEGER,
        executor_kind TEXT,
        status TEXT CHECK(status IN ('pending','in_progress','done','skipped','failed','rejected','waiting_human')) DEFAULT 'pending',
        input_payload TEXT,
        output_payload TEXT,
        provider TEXT,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost_estimate REAL,
        duration_ms INTEGER,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        FOREIGN KEY (run_id) REFERENCES ticket_workflow_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
    )`);

    // Persistente Artefakte (z.B. Plan, Integration-Bericht, Coding-Prompt)
    db.run(`CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        run_id INTEGER,
        step_id INTEGER,
        stage TEXT,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT DEFAULT 'text/markdown',
        size INTEGER,
        content BLOB,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES ticket_workflow_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES ticket_workflow_steps(id) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ai_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        duration_ms INTEGER
    )`);

    // Migration: ticket_workflow_runs um Dossier-Felder erweitern (External-Dispatch)
    db.all('PRAGMA table_info(ticket_workflow_runs)', (pragmaErr, rows) => {
        if (pragmaErr) {
            console.error('Fehler beim Pruefen der ticket_workflow_runs-Struktur:', pragmaErr.message);
            return;
        }
        const cols = (rows || []).map(r => r.name);
        const runMigrations = [
            { col: 'recommended_executor', sql: "ALTER TABLE ticket_workflow_runs ADD COLUMN recommended_executor TEXT" },
            { col: 'dossier_branch', sql: 'ALTER TABLE ticket_workflow_runs ADD COLUMN dossier_branch TEXT' },
            { col: 'dossier_commit_sha', sql: 'ALTER TABLE ticket_workflow_runs ADD COLUMN dossier_commit_sha TEXT' },
            { col: 'dossier_pr_url', sql: 'ALTER TABLE ticket_workflow_runs ADD COLUMN dossier_pr_url TEXT' },
            { col: 'dossier_exported_at', sql: 'ALTER TABLE ticket_workflow_runs ADD COLUMN dossier_exported_at DATETIME' }
        ];
        runMigrations.forEach(m => {
            if (!cols.includes(m.col)) {
                db.run(m.sql, (e) => {
                    if (e) console.error(`Fehler beim Hinzufuegen von ticket_workflow_runs.${m.col}:`, e.message);
                });
            }
        });
    });

    // Migration fuer bestehende DBs: CHECK-Constraint um neue Rollen erweitern
    migrateWorkflowRoleConstraints();

    // Migration: ticket_workflow_steps um actual_approver_id (Audit: wer hat
    // tatsaechlich entschieden, falls != staff_id der Zuweisung).
    db.all('PRAGMA table_info(ticket_workflow_steps)', (pragmaErr, rows) => {
        if (pragmaErr) {
            console.error('Fehler beim Pruefen der ticket_workflow_steps-Struktur:', pragmaErr.message);
            return;
        }
        const cols = (rows || []).map(r => r.name);
        if (!cols.includes('actual_approver_id')) {
            // SQLite erlaubt FK in ALTER TABLE — sie wird referenz-haft eingetragen,
            // aber ohne harten Check (PRAGMA foreign_keys ist ohnehin Default off
            // in dieser App). Bewusst kein Default, damit Alt-Daten NULL bleiben.
            db.run('ALTER TABLE ticket_workflow_steps ADD COLUMN actual_approver_id INTEGER REFERENCES staff(id) ON DELETE SET NULL', (e) => {
                if (e) console.error('Fehler beim Hinzufuegen von ticket_workflow_steps.actual_approver_id:', e.message);
            });
        }
    });
}

// Bei aelteren DBs enthalten die CHECK-Constraints von staff_roles/workflow_stages/
// ticket_workflow_steps neue Rollen (z.B. 'coding', 'clarifier') noch nicht.
// SQLite erlaubt CHECK-Aenderung nur per Tabellen-Rebuild. Wir pruefen das DDL
// in sqlite_master und bauen bei Bedarf um.
//
// Strategie: Pruefung erfolgt anhand der NEUESTEN Rolle, die hinzugekommen ist.
// Wenn diese im DDL fehlt, wird die Tabelle migriert. So funktioniert die
// Funktion fuer jede zukuenftige Rollen-Erweiterung — die Liste der erwarteten
// Rollen wird einfach in REQUIRED_ROLES aktualisiert.
function migrateWorkflowRoleConstraints() {
    // Aktuell juengste Rolle. Wenn sie im DDL fehlt -> Migration noetig.
    const LATEST_ROLE = 'clarifier';
    const targets = [
        {
            table: 'staff_roles',
            create: `CREATE TABLE staff_roles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                staff_id INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('triage','security','planning','integration','approval','coding','clarifier')),
                priority INTEGER DEFAULT 100,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(staff_id, role),
                FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
            )`,
            cols: 'id, staff_id, role, priority, active, created_at'
        },
        {
            table: 'workflow_stages',
            create: `CREATE TABLE workflow_stages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('triage','security','planning','integration','approval','coding','clarifier')),
                executor_kind TEXT CHECK(executor_kind IN ('ai','human','any')) DEFAULT 'any',
                auto_assign_strategy TEXT CHECK(auto_assign_strategy IN ('round_robin','least_loaded','fixed')) DEFAULT 'round_robin',
                fixed_staff_id INTEGER,
                FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE,
                FOREIGN KEY (fixed_staff_id) REFERENCES staff(id) ON DELETE SET NULL,
                UNIQUE(workflow_id, sort_order)
            )`,
            cols: 'id, workflow_id, sort_order, role, executor_kind, auto_assign_strategy, fixed_staff_id'
        },
        {
            table: 'ticket_workflow_steps',
            create: `CREATE TABLE ticket_workflow_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                stage TEXT NOT NULL CHECK(stage IN ('triage','security','planning','integration','approval','coding','clarifier')),
                sort_order INTEGER NOT NULL,
                staff_id INTEGER,
                executor_kind TEXT,
                status TEXT CHECK(status IN ('pending','in_progress','done','skipped','failed','rejected','waiting_human')) DEFAULT 'pending',
                input_payload TEXT,
                output_payload TEXT,
                provider TEXT,
                model TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                cost_estimate REAL,
                duration_ms INTEGER,
                error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME,
                FOREIGN KEY (run_id) REFERENCES ticket_workflow_runs(id) ON DELETE CASCADE,
                FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
            )`,
            cols: 'id, run_id, stage, sort_order, staff_id, executor_kind, status, input_payload, output_payload, provider, model, prompt_tokens, completion_tokens, cost_estimate, duration_ms, error, created_at, finished_at'
        }
    ];

    targets.forEach(t => {
        db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", [t.table], (err, row) => {
            if (err || !row || !row.sql) return;
            if (row.sql.includes(`'${LATEST_ROLE}'`)) return; // schon migriert
            console.log(`Migration: ${t.table} -> CHECK um '${LATEST_ROLE}' erweitern`);
            // Sequentielle Ausfuehrung ohne Transaktion (SQLite Auto-Commit pro Statement).
            // Mehrere parallele BEGIN ueber verschiedene serialize()-Bloecke wuerden konfligieren.
            db.serialize(() => {
                db.run('PRAGMA foreign_keys = OFF');
                db.run(`DROP TABLE IF EXISTS _new_${t.table}`);
                db.run(t.create.replace(t.table, '_new_' + t.table), (e1) => {
                    if (e1) { console.error(`Migration ${t.table} CREATE fehlgeschlagen:`, e1.message); return; }
                    db.run(`INSERT INTO _new_${t.table} (${t.cols}) SELECT ${t.cols} FROM ${t.table}`, (e2) => {
                        if (e2) { console.error(`Migration ${t.table} INSERT fehlgeschlagen:`, e2.message); return; }
                        db.run(`DROP TABLE ${t.table}`, (e3) => {
                            if (e3) { console.error(`Migration ${t.table} DROP fehlgeschlagen:`, e3.message); return; }
                            db.run(`ALTER TABLE _new_${t.table} RENAME TO ${t.table}`, (e4) => {
                                if (e4) { console.error(`Migration ${t.table} RENAME fehlgeschlagen:`, e4.message); return; }
                                db.run('PRAGMA foreign_keys = ON');
                                console.log(`Migration ${t.table} abgeschlossen.`);
                            });
                        });
                    });
                });
            });
        });
    });
}

function seedDefaultWorkflow() {
    db.get("SELECT id FROM workflow_definitions WHERE name = 'standard'", (err, row) => {
        if (err) {
            console.error('Fehler beim Pruefen Default-Workflow:', err.message);
            return;
        }
        if (row) return;
        db.run(`INSERT INTO workflow_definitions (name, description, is_default, active)
                VALUES ('standard', 'Standard KI-Pipeline: Triage -> Security -> Planning -> Integration -> Approval', 1, 1)`,
            function(insertErr) {
                if (insertErr) {
                    console.error('Fehler beim Anlegen Default-Workflow:', insertErr.message);
                    return;
                }
                const wfId = this.lastID;
                const stages = [
                    { sort: 1, role: 'triage', kind: 'ai' },
                    { sort: 2, role: 'security', kind: 'ai' },
                    { sort: 3, role: 'planning', kind: 'ai' },
                    { sort: 4, role: 'integration', kind: 'ai' },
                    { sort: 5, role: 'approval', kind: 'human' }
                ];
                const stmt = db.prepare(`INSERT INTO workflow_stages
                    (workflow_id, sort_order, role, executor_kind, auto_assign_strategy)
                    VALUES (?, ?, ?, ?, 'round_robin')`);
                stages.forEach(s => stmt.run(wfId, s.sort, s.role, s.kind));
                stmt.finalize();
                console.log('Default-Workflow "standard" angelegt.');
            });
    });
}

function initTicketsTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT CHECK(type IN ('bug', 'feature')) DEFAULT 'bug',
            title TEXT NOT NULL,
            description TEXT,
            username TEXT,
            console_logs TEXT,
            software_info TEXT,
            status TEXT CHECK(status IN ('offen', 'in_bearbeitung', 'wartend', 'umgesetzt', 'geschlossen', 'überprüft')) DEFAULT 'offen',
            priority TEXT CHECK(priority IN ('niedrig', 'mittel', 'hoch', 'kritisch')) DEFAULT 'mittel',
            system_id INTEGER,
            assigned_to INTEGER,
            location TEXT,
            contact_email TEXT,
            urgency TEXT CHECK(urgency IN ('normal','emergency','safety')) DEFAULT 'normal',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            first_responded_at DATETIME,
            closed_at DATETIME,
            feedback_requested INTEGER DEFAULT 0,
            reference_repo_owner TEXT,
            reference_repo_name TEXT
        )
    `, (err) => {
        if (err) console.error('Fehler beim Erstellen der tickets-Tabelle:', err.message);
        initDb();
    });
}

initTicketsTable();

aiClient.setTokenLogger((provider, model, promptTokens, completionTokens, durationMs) => {
    db.run(
        'INSERT INTO ai_token_usage (provider, model, prompt_tokens, completion_tokens, duration_ms) VALUES (?, ?, ?, ?, ?)',
        [provider, model, promptTokens, completionTokens, durationMs || null],
        (err) => { if (err) console.error('[token-usage] Insert failed:', err.message); }
    );
});

// --- SLA Funktionen ---

function calculateSLADue(priority, createdAt) {
    const start = new Date(createdAt);
    const firstResponseHours = SLA_CONFIG.first_response[priority] || 8;
    const resolutionHours = SLA_CONFIG.resolution[priority] || 72;
    
    const firstResponseDue = new Date(start.getTime() + firstResponseHours * 3600000);
    const resolutionDue = new Date(start.getTime() + resolutionHours * 3600000);
    
    return { firstResponseDue, resolutionDue };
}

function initSLA(ticketId, priority, createdAt) {
    const { firstResponseDue, resolutionDue } = calculateSLADue(priority, createdAt);
    
    db.run(`INSERT OR REPLACE INTO ticket_sla 
        (ticket_id, first_response_due, resolution_due) VALUES (?, ?, ?)`,
        [ticketId, firstResponseDue.toISOString(), resolutionDue.toISOString()],
        (err) => { if (err) console.error('SLA Init Error:', err.message); }
    );
}

function updateSLAFirstResponse(ticketId) {
    db.run(`UPDATE ticket_sla SET first_response_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`,
        [ticketId], (err) => { if (err) console.error('SLA Update Error:', err.message); }
    );
}

function updateSLAResolution(ticketId) {
    db.run(`UPDATE ticket_sla SET resolution_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`,
        [ticketId], (err) => { if (err) console.error('SLA Update Error:', err.message); }
    );
}

function getSLAStatus(ticketId, callback) {
    db.get(`SELECT * FROM ticket_sla WHERE ticket_id = ?`, [ticketId], (err, sla) => {
        if (err || !sla) return callback(null);
        
        const now = new Date();
        const firstResponseDue = sla.first_response_due ? new Date(sla.first_response_due) : null;
        const resolutionDue = sla.resolution_due ? new Date(sla.resolution_due) : null;
        
        let firstResponseStatus = 'pending';
        if (sla.first_response_at) {
            firstResponseStatus = new Date(sla.first_response_at) <= firstResponseDue ? 'fulfilled' : 'breached';
        } else if (firstResponseDue && now > firstResponseDue) {
            firstResponseStatus = 'breached';
        }
        
        let resolutionStatus = 'pending';
        if (sla.resolution_at) {
            resolutionStatus = new Date(sla.resolution_at) <= resolutionDue ? 'fulfilled' : 'breached';
        } else if (resolutionDue && now > resolutionDue) {
            resolutionStatus = 'breached';
        }
        
        callback({
            firstResponseDue: sla.first_response_due,
            firstResponseAt: sla.first_response_at,
            firstResponseStatus,
            resolutionDue: sla.resolution_due,
            resolutionAt: sla.resolution_at,
            resolutionStatus
        });
    });
}

// --- Activity Stream Funktionen ---

function addActivity(ticketId, actor, actionType, actionText, metadata = {}) {
    db.run(`INSERT INTO activity_stream (ticket_id, actor, action_type, action_text, metadata) 
        VALUES (?, ?, ?, ?, ?)`,
        [ticketId, actor, actionType, actionText, JSON.stringify(metadata)],
        (err) => { if (err) console.error('Activity Error:', err.message); }
    );
    
    // Socket.io Broadcast
    io.emit('activity', { ticketId, actor, actionType, actionText, metadata, timestamp: new Date() });
}

function getActivities(ticketId, callback) {
    db.all(`SELECT * FROM activity_stream WHERE ticket_id = ? ORDER BY created_at DESC`,
        [ticketId], (err, rows) => {
            if (err) return callback([]);
            callback(rows.map(r => ({
                ...r,
                metadata: r.metadata ? JSON.parse(r.metadata) : {}
            })));
        });
}

// --- Feedback Funktionen ---

function addFeedback(ticketId, rating, comment, callback) {
    db.run(`INSERT OR REPLACE INTO ticket_feedback (ticket_id, rating, comment) VALUES (?, ?, ?)`,
        [ticketId, rating, comment],
        function(err) {
            if (err) return callback(err);
            callback(null, { id: this.lastID });
        });
}

function getFeedback(ticketId, callback) {
    db.get(`SELECT * FROM ticket_feedback WHERE ticket_id = ?`, [ticketId], (err, row) => {
        callback(err, row);
    });
}

function getAverageFeedback(callback) {
    db.get(`SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM ticket_feedback`, [], (err, row) => {
        callback(err, row);
    });
}

// --- Audit Log ---

function logAction(ticketId, user, action, details) {
    if (!ticketId) return;
    db.run('INSERT INTO audit_log (ticket_id, user, action, details) VALUES (?, ?, ?, ?)', 
        [ticketId, user, action, details], (err) => {
            if (err) console.error('Audit Log Error:', err.message);
        });
}

function getActor(req) {
    return (req.session && req.session.user) || ADMIN_USER || 'System';
}

function startAuthenticatedSession(req, res, sessionUser, redirectTo = '/') {
    req.session.regenerate((err) => {
        if (err) return res.status(500).send('Session konnte nicht erneuert werden.');
        req.session.authenticated = true;
        req.session.user = sessionUser.username;
        req.session.role = sessionUser.role;
        req.session.staff_id = sessionUser.staff_id || null;
        req.session.default_system_id = sessionUser.default_system_id || null;
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        res.redirect(redirectTo);
    });
}

function calculateDeadline(type, urgency, priority, baseDate = new Date()) {
    const start = new Date(baseDate);
    const startDate = Number.isNaN(start.getTime()) ? new Date() : start;

    if (type !== 'bug') return null;

    let hoursToDeadline = null;
    if (urgency === 'emergency') {
        hoursToDeadline = 4;
    } else if (urgency === 'safety') {
        hoursToDeadline = 8;
    } else if (priority === 'kritisch') {
        hoursToDeadline = 24;
    }

    if (!hoursToDeadline) return null;

    startDate.setHours(startDate.getHours() + hoursToDeadline);
    return startDate.toISOString();
}

function formatDuration(ms) {
    const totalMinutes = Math.max(1, Math.round(Math.abs(ms) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];

    if (days) parts.push(`${days} Tag${days === 1 ? '' : 'e'}`);
    if (hours) parts.push(`${hours} Std.`);
    if (!days && minutes) parts.push(`${minutes} Min.`);

    return parts.join(' ');
}

function formatMinutes(minutes) {
    if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '-';
    return formatDuration(Number(minutes) * 60000);
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || {});
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getReminderInfo(ticket) {
    if (!ticket || !ticket.deadline) return null;

    const deadline = new Date(ticket.deadline);
    if (Number.isNaN(deadline.getTime())) return null;

    const now = new Date();
    const diffMs = deadline.getTime() - now.getTime();
    const isClosed = ticket.status === 'geschlossen';
    const deadlineText = app.locals.formatDateTime(ticket.deadline);

    if (isClosed) {
        return {
            level: 'closed',
            title: 'Frist dokumentiert',
            message: `Frist war ${deadlineText}. Ticket ist bereits geschlossen.`,
            deadlineText
        };
    }

    if (diffMs <= 0) {
        return {
            level: 'overdue',
            title: 'Frist überschritten',
            message: `Dringlicher Bug ist seit ${formatDuration(diffMs)} überfällig.`,
            deadlineText
        };
    }

    const reminderWindowMs = 2 * 60 * 60 * 1000;
    if (diffMs <= reminderWindowMs) {
        return {
            level: 'due-soon',
            title: 'Frist läuft bald ab',
            message: `Noch ${formatDuration(diffMs)} bis zur Termingrenze.`,
            deadlineText
        };
    }

    return {
        level: 'scheduled',
        title: 'Frist aktiv',
        message: `Termingrenze endet in ${formatDuration(diffMs)}.`,
        deadlineText
    };
}

function enrichTicket(ticket) {
    if (!ticket) return ticket;
    return {
        ...ticket,
        reminder: getReminderInfo(ticket)
    };
}

function normalizeAuditValue(key, value) {
    if (value === undefined || value === null || value === '') return 'leer';
    if (key === 'assigned_to') return value ? `Mitarbeiter #${value}` : 'nicht zugewiesen';
    if (key === 'system_id') return value ? `System #${value}` : 'kein System';
    if (key === 'deadline') return app.locals.formatDateTime(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function buildTicketChangeDetails(oldTicket, updates) {
    return Object.entries(updates)
        .filter(([key]) => key !== 'updated_at')
        .map(([key, value]) => {
            const oldValue = oldTicket ? oldTicket[key] : undefined;
            const previous = oldValue === null || oldValue === undefined ? null : String(oldValue);
            const next = value === null || value === undefined ? null : String(value);
            if (previous === next) return null;
            return `${key}: ${normalizeAuditValue(key, oldValue)} → ${normalizeAuditValue(key, value)}`;
        })
        .filter(Boolean)
        .join(', ');
}

// --- E-Mail Service ---

let transporter = null;
let mailProvider = 'disabled';

function parseMailSender(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return { name: '', email: '' };

    const match = trimmed.match(/^(.*)<([^>]+)>$/);
    if (match) {
        return {
            name: match[1].trim().replace(/^"|"$/g, ''),
            email: match[2].trim()
        };
    }

    if (trimmed.includes('@')) {
        return { name: '', email: trimmed };
    }

    return { name: trimmed, email: '' };
}

function getMailSender() {
    const parsedSmtpSender = parseMailSender(SMTP_FROM);
    return {
        name: BREVO_FROM_NAME || parsedSmtpSender.name || 'Ticketsystem',
        email: BREVO_FROM_EMAIL || parsedSmtpSender.email || SMTP_USER || ''
    };
}

function hasMailProvider() {
    return mailProvider !== 'disabled';
}

function normalizeMailRecipients(value) {
    if (Array.isArray(value)) {
        return value.map(item => (item || '').trim()).filter(Boolean);
    }

    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function sendBrevoMail(to, subject, html, text) {
    const recipients = normalizeMailRecipients(to);
    if (!recipients.length) return;

    const sender = getMailSender();
    if (!sender.email) {
        console.error('Brevo Versand nicht moeglich: Keine Absenderadresse konfiguriert.');
        return;
    }

    const payload = {
        sender,
        to: recipients.map(email => ({ email })),
        subject,
        htmlContent: html
    };

    if (text) payload.textContent = text;

    const request = https.request(BREVO_API_URL, {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': BREVO_API_KEY,
            'content-type': 'application/json'
        }
    }, (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
            responseBody += chunk;
        });
        response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
                console.log('Mail via Brevo gesendet an', recipients.join(', '));
                return;
            }

            const details = responseBody ? ` ${responseBody}` : '';
            console.error(`Brevo Mail-Fehler (${response.statusCode || 'unbekannt'}):${details}`);
        });
    });

    request.on('error', (error) => {
        console.error('Brevo Mail-Fehler:', error.message);
    });

    request.write(JSON.stringify(payload));
    request.end();
}

function initMailer() {
    if (BREVO_API_KEY) {
        mailProvider = 'brevo';
        console.log('Brevo Mailversand aktiviert.');
        return;
    }

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        console.log('SMTP nicht konfiguriert. Keine E-Mails werden versendet.');
        return;
    }
    try {
        transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        mailProvider = 'smtp';
        transporter.verify((err) => {
            if (err) console.error('SMTP Verbindung fehlgeschlagen:', err.message);
            else console.log('SMTP Verbindung erfolgreich.');
        });
    } catch(e) {
        console.error('SMTP Initialisierung fehlgeschlagen:', e.message);
    }
}
initMailer();

function sendMail(to, subject, html, text) {
    if (mailProvider === 'brevo') {
        sendBrevoMail(to, subject, html, text);
        return;
    }

    if (!transporter) return;
    transporter.sendMail({
        from: SMTP_FROM || 'Ticketsystem',
        to: to,
        subject: subject,
        text: text,
        html: html
    }, (err, info) => {
        if (err) console.error('Mail-Fehler:', err.message);
        else console.log('Mail gesendet an', to);
    });
}

function getNotificationRecipients(type, filters, callback) {
    const conditions = [
        'u.active = 1',
        's.active = 1',
        's.email IS NOT NULL',
        "TRIM(s.email) != ''"
    ];
    const params = [];

    if (type === 'new') conditions.push('u.notify_new_tickets = 1');
    if (type === 'assigned') conditions.push('u.notify_assigned_tickets = 1');
    if (type === 'status') conditions.push('u.notify_status_changes = 1');

    if (filters.staffId) {
        conditions.push('u.staff_id = ?');
        params.push(filters.staffId);
    }

    if (filters.systemId) {
        conditions.push('(u.default_system_id IS NULL OR u.default_system_id = ?)');
        params.push(filters.systemId);
    }

    db.all(`SELECT DISTINCT s.email
        FROM users u
        INNER JOIN staff s ON u.staff_id = s.id
        WHERE ${conditions.join(' AND ')}`,
        params,
        (err, rows) => {
            if (err) {
                console.error('Fehler beim Laden der Mail-Empfaenger:', err.message);
                return callback([]);
            }
            callback(rows.map(row => row.email));
        }
    );
}

function sendMailToRecipients(recipients, subject, html, text) {
    const uniqueRecipients = [...new Set((recipients || []).filter(Boolean))];
    if (!uniqueRecipients.length) return;
    sendMail(uniqueRecipients.join(', '), subject, html, text);
}

function mailNewTicket(ticket, staff) {
    if (!EMAIL_NOTIFY_NEW || !hasMailProvider()) return;
    const recipients = [];
    if (ticket.contact_email) recipients.push(ticket.contact_email);

    let to = recipients.join(', ');
    let subject = `[Ticket #${ticket.id}] Neues Ticket erstellt: ${ticket.title}`;
    let html = `<p>Ein neues Ticket wurde erstellt.</p>
        <table border="0" cellpadding="6" style="font-family:sans-serif;font-size:14px">
        <tr><td><b>ID:</b></td><td>#${ticket.id}</td></tr>
        <tr><td><b>Titel:</b></td><td>${ticket.title}</td></tr>
        <tr><td><b>Typ:</b></td><td>${ticket.type}</td></tr>
        <tr><td><b>Priorität:</b></td><td>${ticket.priority}</td></tr>
        <tr><td><b>Standort:</b></td><td>${ticket.location || '-'}</td></tr>
        <tr><td><b>Erstellt von:</b></td><td>${ticket.username || '-'}</td></tr>
        </table>
        <p><a href="${BASE_URL}/ticket/${ticket.id}">Zum Ticket</a></p>`;
    getNotificationRecipients('new', { systemId: ticket.system_id }, (userRecipients) => {
        sendMailToRecipients([...recipients, ...userRecipients], subject, html, 'Neues Ticket erstellt. Siehe Webinterface.');
    });
}

function mailStatusChange(ticket, oldStatus) {
    if (!EMAIL_NOTIFY_STATUS || !hasMailProvider()) return;
    const recipients = [];
    if (ticket.contact_email) recipients.push(ticket.contact_email);
    let subject = `[Ticket #${ticket.id}] Status geändert: ${ticket.status}`;
    let html = `<p>Das Ticket #${ticket.id} hat den Status gewechselt.</p>
        <table border="0" cellpadding="6" style="font-family:sans-serif;font-size:14px">
        <tr><td><b>ID:</b></td><td>#${ticket.id}</td></tr>
        <tr><td><b>Titel:</b></td><td>${ticket.title}</td></tr>
        <tr><td><b>Alter Status:</b></td><td>${oldStatus}</td></tr>
        <tr><td><b>Neuer Status:</b></td><td>${ticket.status}</td></tr>
        </table>
        <p><a href="${BASE_URL}/ticket/${ticket.id}">Zum Ticket</a></p>`;
    getNotificationRecipients('status', { staffId: ticket.assigned_to }, (userRecipients) => {
        sendMailToRecipients([...recipients, ...userRecipients], subject, html, `Status geändert zu ${ticket.status}`);
    });
}

function mailAssigned(ticket, staff) {
    if (!EMAIL_NOTIFY_ASSIGN || !hasMailProvider() || !staff) return;
    let subject = `[Ticket #${ticket.id}] Dir zugewiesen: ${ticket.title}`;
    let html = `<p>Dir wurde ein Ticket zugewiesen.</p>
        <table border="0" cellpadding="6" style="font-family:sans-serif;font-size:14px">
        <tr><td><b>ID:</b></td><td>#${ticket.id}</td></tr>
        <tr><td><b>Titel:</b></td><td>${ticket.title}</td></tr>
        <tr><td><b>Standort:</b></td><td>${ticket.location || '-'}</td></tr>
        <tr><td><b>Kontakt:</b></td><td>${ticket.username || '-'} (${ticket.contact_email || '-'})</td></tr>
        </table>
        <p><a href="${BASE_URL}/ticket/${ticket.id}">Zum Ticket</a></p>`;
    const recipients = staff.email ? [staff.email] : [];
    getNotificationRecipients('assigned', { staffId: staff.id }, (userRecipients) => {
        sendMailToRecipients([...recipients, ...userRecipients], subject, html, `Ticket #${ticket.id} wurde dir zugewiesen.`);
    });
}

function mailComment(ticket, note, author) {
    if (!EMAIL_NOTIFY_COMMENT || !hasMailProvider() || !ticket.contact_email || note.is_internal) return;
    let subject = `[Ticket #${ticket.id}] Neuer Kommentar: ${ticket.title}`;
    let html = `<p>Ein neuer Kommentar wurde zu Ticket #${ticket.id} hinzugefügt.</p>
        <p><b>Von:</b> ${author}</p>
        <p><b>Kommentar:</b></p>
        <blockquote style="border-left: 3px solid #ccc; padding-left: 10px; margin-left: 0;">${note.text}</blockquote>
        <p><a href="${BASE_URL}/ticket/${ticket.id}">Zum Ticket</a></p>`;
    sendMail(ticket.contact_email, subject, html, 'Neuer Kommentar zu Ihrem Ticket.');
}

// --- Socket.io ---

io.on('connection', (socket) => {
    
    socket.on('join-ticket', (ticketId) => {
        socket.join(`ticket-${ticketId}`);
    });
    
    socket.on('leave-ticket', (ticketId) => {
        socket.leave(`ticket-${ticketId}`);
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// --- Auth Routes ---

app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.render('login', { error: req.query.error || null });
});

app.post('/login', loginRateLimit, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.redirect('/login?error=Benutzername%20und%20Passwort%20erforderlich');

    // Root user from env
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        return startAuthenticatedSession(req, res, {
            username,
            role: 'root',
            staff_id: null,
            default_system_id: null
        });
    }

    // DB users
    db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username], (err, user) => {
        if (err || !user) return res.redirect('/login?error=Ungueltige%20Anmeldedaten');
        if (!verifyPassword(password, user.password_hash)) return res.redirect('/login?error=Ungueltige%20Anmeldedaten');
        startAuthenticatedSession(req, res, user);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// --- API: Systems ---

app.get('/api/systems', requireAuth, (req, res) => {
    db.all('SELECT * FROM systems WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json((rows || []).map(row => ({
            ...row,
            repo_url: row.repo_owner && row.repo_name ? `https://github.com/${row.repo_owner}/${row.repo_name}` : null,
            repo_access_token: row.repo_access_token ? '***' : null
        })));
    });
});

app.post('/api/systems', requireAuth, requireAdmin, (req, res) => {
    const data = parseSystemPayload(req.body);
    if (!data.name) return res.status(400).json({ error: 'Name ist erforderlich.' });
    db.run(`INSERT INTO systems (name, description, repo_owner, repo_name, repo_access_token, repo_webhook_secret, ai_workflow_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.name, data.description, data.repo_owner, data.repo_name, data.repo_access_token, data.repo_webhook_secret, data.ai_workflow_enabled],
    function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
});

// --- API: Staff ---

app.get('/api/staff', requireAuth, requireAdmin, (req, res) => {
    loadStaffWithRoles((err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/staff/:id', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT * FROM staff WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
        db.all('SELECT role, priority, active FROM staff_roles WHERE staff_id = ?', [req.params.id], (rolesErr, roles) => {
            if (rolesErr) return res.status(500).json({ error: rolesErr.message });
            db.all(`SELECT ssa.system_id, ssa.is_primary, sys.name AS system_name
                FROM staff_system_assignments ssa
                INNER JOIN systems sys ON sys.id = ssa.system_id
                WHERE ssa.staff_id = ? AND ssa.active = 1
                ORDER BY sys.name`, [req.params.id], (sysErr, assignments) => {
                if (sysErr) return res.status(500).json({ error: sysErr.message });
                row.roles = roles;
                row.system_assignments = assignments || [];
                res.json(row);
            });
        });
    });
});

app.post('/api/staff', requireAuth, requireAdmin, (req, res) => {
    const data = parseStaffPayload(req.body);
    if (!data.name || !data.email) return res.status(400).json({ error: 'Name und E-Mail sind erforderlich.' });
    const roles = normalizeRolesInput(req.body);
    const systemAssignments = data.kind === 'human' ? normalizeSystemAssignmentsInput(req.body) : [];
    db.run(`INSERT INTO staff
            (name, email, phone, kind, ai_provider, ai_model, ai_temperature, ai_system_prompt, ai_max_tokens, ai_extra_config)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.name, data.email, data.phone, data.kind, data.ai_provider, data.ai_model,
         data.ai_temperature, data.ai_system_prompt, data.ai_max_tokens, data.ai_extra_config],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const newId = this.lastID;
            replaceStaffRoles(newId, roles, (rolesErr) => {
                if (rolesErr) return res.status(500).json({ error: rolesErr.message });
                replaceStaffSystemAssignments(newId, systemAssignments, (sysErr) => {
                    if (sysErr) return res.status(500).json({ error: sysErr.message });
                    res.json({ id: newId });
                });
            });
        });
});

app.post('/api/staff/:id/roles', requireAuth, requireAdmin, (req, res) => {
    const roles = normalizeRolesInput(req.body);
    replaceStaffRoles(req.params.id, roles, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'ok', roles });
    });
});

// --- API: AI Provider Health ---

app.get('/api/ai/providers/health', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await aiClient.health();
        res.json({ default_provider: aiClient.DEFAULT_PROVIDER, providers: result, config: aiClient.getConfigSummary() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API: Workflow ---

app.get('/api/tickets/:id/workflow', requireAuth, (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung' });
        db.get('SELECT * FROM ticket_workflow_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', [ticketId], (err2, run) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (!run) return res.json({ run: null, steps: [], artifacts: [], ticket_briefing: null, system_name: ticket.system_name || null, repo: (ticket.repo_owner && ticket.repo_name) ? `${ticket.repo_owner}/${ticket.repo_name}` : null });
            db.all(`SELECT s.*, st.name AS staff_name, st.kind AS staff_kind,
                    ast.name AS actual_approver_name
                FROM ticket_workflow_steps s
                LEFT JOIN staff st ON st.id = s.staff_id
                LEFT JOIN staff ast ON ast.id = s.actual_approver_id
                WHERE s.run_id = ? ORDER BY s.sort_order, s.id`, [run.id], (err3, steps) => {
                if (err3) return res.status(500).json({ error: err3.message });
                steps = steps.map(s => {
                    if (s.output_payload) {
                        try { s.output = JSON.parse(s.output_payload); } catch (_) {}
                    }
                    delete s.output_payload;
                    if (s.output && s.output.markdown) {
                        try { s.output_html = marked.parse(s.output.markdown); } catch (_) {}
                    }
                    return s;
                });
                db.all(`SELECT id, stage, kind, filename, mime_type, size, created_at
                    FROM workflow_artifacts WHERE ticket_id = ? ORDER BY id ASC`, [ticketId], (err4, artifacts) => {
                    if (err4) artifacts = [];
                    const sendWorkflow = (codingBotChoices) => {
                    const briefing = {
                        coding_prompt: ticket.coding_prompt || '',
                        implementation_plan: ticket.implementation_plan || '',
                        integration_assessment: ticket.integration_assessment || '',
                        merge_review: ticket.merge_review || '',
                        redacted_description: ticket.redacted_description || '',
                        final_decision: ticket.final_decision || null
                    };
                    try {
                        briefing.implementation_plan_html = ticket.implementation_plan ? marked.parse(ticket.implementation_plan) : '';
                        briefing.integration_assessment_html = ticket.integration_assessment ? marked.parse(ticket.integration_assessment) : '';
                        briefing.merge_review_html = ticket.merge_review ? marked.parse(ticket.merge_review) : '';
                    } catch (_) {}
                        res.json({ run, steps, artifacts, ticket_briefing: briefing, coding_bot_choices: codingBotChoices || {}, system_name: ticket.system_name || null, repo: (ticket.repo_owner && ticket.repo_name) ? `${ticket.repo_owner}/${ticket.repo_name}` : null });
                    };

                    if (!isAdminRole(req.session.role)) {
                        sendWorkflow({});
                        return;
                    }

                    db.all(`SELECT s.id, s.name, s.coding_level
                        FROM staff_roles sr
                        INNER JOIN staff s ON s.id = sr.staff_id
                        WHERE sr.role = 'coding' AND sr.active = 1 AND s.active = 1
                          AND s.kind = 'ai' AND s.coding_level IN ('medium', 'high')
                        ORDER BY s.coding_level ASC, sr.priority ASC, s.name COLLATE NOCASE ASC, s.id ASC`, [], (err5, botRows) => {
                        if (err5) {
                            sendWorkflow({});
                            return;
                        }
                        const codingBotChoices = { medium: [], high: [] };
                        (botRows || []).forEach(bot => {
                            if (!codingBotChoices[bot.coding_level]) return;
                            codingBotChoices[bot.coding_level].push({ id: bot.id, name: bot.name });
                        });
                        sendWorkflow(codingBotChoices);
                    });
                });
            });
        });
    });
});

app.get('/api/tickets/:id/workflow/artifacts/:artId', requireAuth, (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    const artId = parseInt(req.params.artId, 10);
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung' });
        db.get('SELECT * FROM workflow_artifacts WHERE id = ? AND ticket_id = ?', [artId, ticketId], (err2, art) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (!art) return res.status(404).json({ error: 'Artefakt nicht gefunden' });
            const inline = req.query.inline === '1';
            res.setHeader('Content-Type', art.mime_type || 'application/octet-stream');
            const safeName = String(art.filename || ('artifact-' + art.id)).replace(/["\r\n]/g, '_');
            res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
            res.setHeader('Content-Length', art.content ? art.content.length : 0);
            res.send(art.content);
        });
    });
});

app.post('/api/tickets/:id/workflow/restart', requireAuth, requireAdmin, async (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    db.run('UPDATE tickets SET workflow_run_id = NULL, final_decision = NULL WHERE id = ?', [ticketId], async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
            const runId = await workflowEngine.startForTicket(ticketId);
            res.json({ status: 'started', runId });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

app.post('/api/tickets/:id/workflow/steps/:stepId/decision', requireAuth, async (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const decision = req.body.decision;
    const note = req.body.note ? String(req.body.note).slice(0, 4000) : null;
    const selectedStaffId = req.body.selected_staff_id === undefined || req.body.selected_staff_id === null || req.body.selected_staff_id === ''
        ? null
        : parseInt(req.body.selected_staff_id, 10);
    if (selectedStaffId !== null && Number.isNaN(selectedStaffId)) {
        return res.status(400).json({ error: 'selected_staff_id ist ungueltig' });
    }
    db.get('SELECT t.*, s.staff_id AS step_staff_id, s.run_id FROM ticket_workflow_steps s INNER JOIN tickets t ON t.id = ? WHERE s.id = ?',
        [ticketId, stepId], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Step nicht gefunden' });
        const isAdmin = isAdminRole(req.session.role);
        const isAssigned = req.session.staff_id && Number(req.session.staff_id) === Number(row.step_staff_id);
        if (!isAdmin && !isAssigned) return res.status(403).json({ error: 'Keine Berechtigung' });
        try {
            const result = await workflowEngine.decideHumanStep(row.run_id, stepId, decision, note, getActor(req), {
                split_tickets: Array.isArray(req.body.split_tickets) ? req.body.split_tickets : null,
                selected_staff_id: selectedStaffId,
                actor_staff_id: req.session.staff_id || null
            });
            res.json(result);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
});

// Re-Run einer abgeschlossenen Stage (Triage/Security/Planning/Integration) mit Zusatzinfo
app.post('/api/tickets/:id/workflow/steps/:stepId/rerun', requireAuth, async (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const extraInfo = req.body.extra_info ? String(req.body.extra_info).slice(0, 8000) : '';
    if (!extraInfo.trim()) return res.status(400).json({ error: 'extra_info darf nicht leer sein' });
    if (!isAdminRole(req.session.role)) {
        return res.status(403).json({ error: 'Nur Admin/Approver darf Stages neu ausfuehren' });
    }
    db.get('SELECT s.run_id FROM ticket_workflow_steps s WHERE s.id = ?', [stepId], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Step nicht gefunden' });
        // Prueft per Ticket-Zugehoerigkeit
        db.get(`SELECT 1 FROM ticket_workflow_runs WHERE id = ? AND ticket_id = ?`,
            [row.run_id, ticketId], async (e2, owns) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (!owns) return res.status(404).json({ error: 'Step gehoert nicht zu diesem Ticket' });
            try {
                const result = await workflowEngine.rerunStage(row.run_id, stepId, extraInfo, getActor(req));
                res.json(result);
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });
    });
});

app.delete('/api/staff/:id', requireAuth, requireAdmin, (req, res) => {
    db.run('UPDATE staff SET active = 0 WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'deactivated' });
    });
});

// --- API: Notes ---

app.get('/api/tickets/:id/notes', requireAuth, (req, res) => {
    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (ticketErr, ticket) => {
        if (ticketErr) return res.status(500).json({ error: ticketErr.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung.' });

        const noteQuery = canManageTickets(req)
            ? 'SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at DESC'
            : 'SELECT * FROM ticket_notes WHERE ticket_id = ? AND is_internal = 0 ORDER BY created_at DESC';
        db.all(noteQuery, [req.params.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

app.post('/api/tickets/:id/notes', requireAuth, (req, res) => {
    const { text, is_internal = 1 } = req.body;
    const actor = getActor(req);

    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (ticketErr, ticket) => {
        if (ticketErr) return res.status(500).json({ error: ticketErr.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung.' });

        const noteText = normalizeText(text, 5000);
        const noteIsInternal = canManageTickets(req) ? parseCheckbox(is_internal) : 0;

        db.run('INSERT INTO ticket_notes (ticket_id, author, text, is_internal) VALUES (?, ?, ?, ?)',
            [req.params.id, actor, noteText, noteIsInternal],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });

                const noteId = this.lastID;
                logAction(req.params.id, actor, 'note_added', `${noteIsInternal ? 'Interne' : 'Öffentliche'} Notiz hinzugefügt`);
                addActivity(req.params.id, actor, 'comment', `Kommentar hinzugefügt`, { text: noteText.substring(0, 100), is_internal: noteIsInternal });

                io.to(`ticket-${req.params.id}`).emit('new-note', {
                    ticketId: req.params.id,
                    note: { id: noteId, author: actor, text: noteText, is_internal: noteIsInternal, created_at: new Date().toISOString() }
                });

                if (canManageTickets(req) && !noteIsInternal) mailComment(ticket, { text: noteText, is_internal: noteIsInternal }, actor);

                if (canManageTickets(req) && !ticket.first_responded_at) {
                    db.run('UPDATE tickets SET first_responded_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
                    updateSLAFirstResponse(req.params.id);
                }

                res.json({ id: noteId });
            });
    });
});

// --- API: Templates ---

app.get('/api/templates', requireAuth, (req, res) => {
    db.all('SELECT * FROM ticket_templates WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, fields: r.fields ? JSON.parse(r.fields) : [] })));
    });
});

app.get('/api/templates/:id', requireAuth, (req, res) => {
    db.get('SELECT * FROM ticket_templates WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Template nicht gefunden' });
        res.json({ ...row, fields: row.fields ? JSON.parse(row.fields) : [] });
    });
});

app.post('/api/templates', requireAuth, requireAdmin, (req, res) => {
    const { name, type, description, fields } = req.body;
    db.run('INSERT INTO ticket_templates (name, type, description, fields) VALUES (?, ?, ?, ?)',
        [name, type, description, JSON.stringify(fields)],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
});

// --- API: SLA ---

app.get('/api/tickets/:id/sla', requireAuth, (req, res) => {
    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung.' });
        getSLAStatus(req.params.id, (sla) => {
            res.json(sla || {});
        });
    });
});

// --- API: Activity Stream ---

app.get('/api/tickets/:id/activities', requireAuth, (req, res) => {
    if (!canManageTickets(req)) return res.status(403).json({ error: 'Keine Berechtigung.' });
    getActivities(req.params.id, (activities) => res.json(activities));
});

// --- API: Feedback ---

app.get('/api/tickets/:id/feedback', requireAuth, (req, res) => {
    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (ticketErr, ticket) => {
        if (ticketErr) return res.status(500).json({ error: ticketErr.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung.' });
        getFeedback(req.params.id, (err, feedback) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(feedback || null);
        });
    });
});

app.post('/api/tickets/:id/feedback', requireAuth, (req, res) => {
    const { rating, comment } = req.body;
    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (ticketErr, ticket) => {
        if (ticketErr) return res.status(500).json({ error: ticketErr.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Keine Berechtigung.' });
        addFeedback(req.params.id, rating, comment, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            addActivity(req.params.id, getActor(req), 'feedback', `Feedback abgegeben: ${rating}/5 Sterne`, { rating, comment });
            res.json(result);
        });
    });
});

app.get('/api/feedback/stats', requireAuth, requireAdmin, (req, res) => {
    getAverageFeedback((err, stats) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(stats);
    });
});

// --- API: Tickets ---

app.post('/api/tickets', publicTicketApiRateLimit, requireApiAllowedIp, requireApiKey, (req, res) => {
    const d = req.body;
    d.title = normalizeText(d.title || 'Unbenannt', 200) || 'Unbenannt';
    d.description = normalizeText(d.description || '', 5000);
    d.username = normalizeText(d.username || d.reporterName || d.userName || '', 120) || null;
    d.contact_email = normalizeText(d.contact_email || d.reporterEmail || d.userEmail || '', 254) || null;
    d.location = normalizeText(d.location || d.url || '', 200) || null;
    const referenceRepo = parseGithubRepoReference(
        d.reference_repo,
        d.reference_repo_url,
        d.referenceRepository,
        d.referenceRepo,
        d.reference_repo_owner && d.reference_repo_name ? `${d.reference_repo_owner}/${d.reference_repo_name}` : ''
    );

    // System-Name in system_id auflösen
    if (!d.system_id && d.system) {
        const sysName = normalizeText(d.system, 100);
        db.get('SELECT id FROM systems WHERE name = ? AND active = 1', [sysName], (err, sys) => {
            if (!err && sys) d.system_id = sys.id;
            insertTicket();
        });
    } else {
        insertTicket();
    }

    function insertTicket() {
    let swInfo = d.software_info;
    if (swInfo && typeof swInfo === 'object') swInfo = JSON.stringify(swInfo);
    if (!swInfo) {
        const extraInfo = {};
        if (d.url) extraInfo.url = d.url;
        if (d.userAgent) extraInfo.userAgent = d.userAgent;
        if (d.platform) extraInfo.platform = d.platform;
        if (d.language) extraInfo.language = d.language;
        if (d.screen) extraInfo.screen = d.screen;
        if (d.appVersion) extraInfo.appVersion = d.appVersion;
        if (d.userId) extraInfo.userId = d.userId;
        if (d.tenant) extraInfo.tenant = d.tenant;
        if (d.timestamp) extraInfo.timestamp = d.timestamp;
        if (d.referrer) extraInfo.referrer = d.referrer;
        if (Object.keys(extraInfo).length > 0) swInfo = JSON.stringify(extraInfo);
    }
    
    let deadline = d.deadline ? new Date(d.deadline).toISOString() : null;
    if (!deadline) {
        deadline = calculateDeadline(d.type || 'bug', d.urgency || 'normal', d.priority || 'mittel');
    }

    const stmt = `INSERT INTO tickets (type, title, description, username, console_logs, software_info, status, priority, system_id, assigned_to, location, contact_email, urgency, deadline, reference_repo_owner, reference_repo_name)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const vals = [
        d.type || 'bug', d.title || 'Unbenannt', d.description || '', d.username || null,
        d.console_logs || null, swInfo || null, 'offen', d.priority || 'mittel',
        d.system_id ? parseInt(d.system_id, 10) : null,
        d.assigned_to ? parseInt(d.assigned_to, 10) : null,
        d.location || null, d.contact_email || null, d.urgency || 'normal', deadline,
        referenceRepo.owner, referenceRepo.name
    ];

    db.run(stmt, vals, function(err) {
        if (err) return res.status(500).send('DB Error: ' + err.message);
        const ticketId = this.lastID;
        
        // SLA initialisieren
        initSLA(ticketId, d.priority || 'mittel', new Date().toISOString());
        
        logAction(ticketId, getActor(req), 'created', `Ticket erstellt: ${d.title}${deadline ? ' | Frist bis ' + app.locals.formatDateTime(deadline) : ''}`);
        addActivity(ticketId, getActor(req), 'created', 'Ticket erstellt', { title: d.title, type: d.type });
        
        db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
            if (!err && ticket) mailNewTicket(ticket);
            if (d.assigned_to) {
                db.get('SELECT * FROM staff WHERE id = ?', [d.assigned_to], (err, staff) => {
                    if (!err && staff) mailAssigned(ticket, staff);
                });
            }
        });
        // KI-Workflow asynchron starten
        workflowEngine.startForTicket(ticketId).catch(e => console.error('Workflow-Start (API):', e.message));
        return res.status(201).json({
            id: ticketId,
            status: 'created',
            ticketUrl: `${BASE_URL}/ticket/${ticketId}`,
            apiUrl: `${BASE_URL}/api/tickets/${ticketId}`
        });
    });
    } // end insertTicket
});

app.get('/api/tickets', requireAuth, (req, res) => {
    let query = 'SELECT t.*, s.name as system_name, st.name as assigned_name FROM tickets t LEFT JOIN systems s ON t.system_id = s.id LEFT JOIN staff st ON t.assigned_to = st.id WHERE 1=1';
    const params = [];
    const visibility = ticketVisibilityClause(req, 't');
    query += visibility.clause;
    params.push(...visibility.params);
    if (req.query.status) { query += ' AND t.status = ?'; params.push(req.query.status); }
    if (req.query.type) { query += ' AND t.type = ?'; params.push(req.query.type); }
    if (req.query.priority) { query += ' AND t.priority = ?'; params.push(req.query.priority); }
    if (req.query.system_id) { query += ' AND t.system_id = ?'; params.push(req.query.system_id); }
    if (req.query.assigned_to) { query += ' AND t.assigned_to = ?'; params.push(req.query.assigned_to); }
    if (req.query.urgency) { query += ' AND t.urgency = ?'; params.push(req.query.urgency); }
    if (req.query.search) { query += ' AND (t.title LIKE ? OR t.description LIKE ?)'; params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    params.push(limit, offset);
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => {
            const ticket = { ...r, software_info: r.software_info ? JSON.parse(r.software_info) : null };
            return enrichTicket(ticket);
        }));
    });
});

app.get('/export/csv', requireAuth, (req, res) => {
    const visibility = ticketVisibilityClause(req, 't');
    const query = `SELECT t.id, t.type, t.title, t.status, t.priority, s.name as system_name, st.name as assigned_name, t.created_at
        FROM tickets t
        LEFT JOIN systems s ON t.system_id = s.id
        LEFT JOIN staff st ON t.assigned_to = st.id
        WHERE 1=1${visibility.clause}
        ORDER BY t.created_at DESC`;
    db.all(query, visibility.params, (err, rows) => {
        if (err) return res.status(500).send('DB Error');
        
        let csv = 'ID,Typ,Titel,Status,Priorität,System,Zuweisung,Erstellt\n';
        rows.forEach(r => {
            const row = [
                r.id,
                r.type,
                `"${r.title.replace(/"/g, '""')}"`,
                r.status,
                r.priority,
                r.system_name || '-',
                r.assigned_name || '-',
                r.created_at
            ].join(',');
            csv += row + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=tickets_export.csv');
        res.send(csv);
    });
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
    db.get('SELECT t.*, s.name as system_name, st.name as assigned_name, st.email as assigned_email FROM tickets t LEFT JOIN systems s ON t.system_id = s.id LEFT JOIN staff st ON t.assigned_to = st.id WHERE t.id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        if (!canViewTicket(req, row)) return res.status(403).json({ error: 'Keine Berechtigung.' });
        const t = enrichTicket({ ...row });
        if (t.software_info) { try { t.software_info = JSON.parse(t.software_info); } catch(e) {} }
        res.json(t);
    });
});

app.patch('/api/tickets/:id', requireAuth, requireAdmin, (req, res) => {
    const allowed = ['title', 'description', 'status', 'priority', 'type', 'username', 'console_logs', 'software_info', 'system_id', 'assigned_to', 'location', 'contact_email', 'urgency'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Keine gueltigen Felder zum Aktualisieren' });
    }

    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, oldTicket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!oldTicket) return res.status(404).json({ error: 'Ticket nicht gefunden' });

        if (updates.urgency !== undefined || updates.priority !== undefined || updates.type !== undefined) {
            updates.deadline = calculateDeadline(
                updates.type || oldTicket.type,
                updates.urgency || oldTicket.urgency,
                updates.priority || oldTicket.priority
            );
        }

        if (updates.status === 'geschlossen' && oldTicket.status !== 'geschlossen') {
            updates.closed_at = new Date().toISOString();
            updates.feedback_requested = 0;
        } else if (updates.status && updates.status !== 'geschlossen' && oldTicket.status === 'geschlossen') {
            updates.closed_at = null;
            updates.feedback_requested = 0;
        }

        if (updates.software_info && typeof updates.software_info === 'object') {
            updates.software_info = JSON.stringify(updates.software_info);
        }
        updates.updated_at = new Date().toISOString();

        const auditDetails = buildTicketChangeDetails(oldTicket, updates) || 'Ticket aktualisiert';
        const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), req.params.id];
        
        db.run(`UPDATE tickets SET ${setClause} WHERE id = ?`, values, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Ticket nicht gefunden' });

            logAction(req.params.id, getActor(req), 'updated', auditDetails);

            db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, ticket) => {
                if (updates.status && oldTicket && oldTicket.status !== updates.status) {
                    addActivity(req.params.id, getActor(req), 'status_changed', `Status geändert: ${oldTicket.status} → ${updates.status}`, {
                        old: oldTicket.status,
                        new: updates.status
                    });
                    mailStatusChange(ticket, oldTicket.status);
                    if (updates.status === 'geschlossen') {
                        updateSLAResolution(req.params.id);
                        addActivity(req.params.id, getActor(req), 'closed', 'Ticket geschlossen', {});
                    }
                }
                if (updates.assigned_to && (!oldTicket || oldTicket.assigned_to !== updates.assigned_to)) {
                    db.get('SELECT * FROM staff WHERE id = ?', [updates.assigned_to], (err, staff) => {
                        if (!err && staff) mailAssigned(ticket, staff);
                    });
                }
            });
            if (updates.status) {
                io.to(`ticket-${req.params.id}`).emit('ticket-updated', {
                    ticketId: req.params.id,
                    updates: { status: updates.status },
                    actor: getActor(req)
                });
            }
            res.json({
                id: req.params.id,
                status: 'updated',
                redirect: updates.status === 'geschlossen' ? '/' : null
            });
        });
    });
});

app.delete('/api/tickets/:id', requireAuth, requireAdmin, (req, res) => {
    logAction(req.params.id, getActor(req), 'deleted', `Ticket gelöscht`);
    db.run('DELETE FROM tickets WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        res.json({ id: req.params.id, status: 'deleted' });
    });
});

// --- API: Ticket Pins ---

app.post('/api/tickets/:id/pin', requireAuth, (req, res) => {
    const username = req.session.user;
    db.run('INSERT OR IGNORE INTO ticket_pins (username, ticket_id) VALUES (?, ?)',
        [username, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ pinned: true });
        });
});

app.delete('/api/tickets/:id/pin', requireAuth, (req, res) => {
    const username = req.session.user;
    db.run('DELETE FROM ticket_pins WHERE username = ? AND ticket_id = ?',
        [username, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ pinned: false });
        });
});

app.get('/api/pins', requireAuth, (req, res) => {
    db.all('SELECT ticket_id FROM ticket_pins WHERE username = ?', [req.session.user], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.ticket_id));
    });
});

// --- API: Projects ---

app.get('/api/projects', requireAuth, (req, res) => {
    db.all(`
        SELECT p.*, s.name as system_name,
            (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id) as milestone_count,
            (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id AND status = 'completed') as completed_milestones,
            (SELECT COUNT(*) FROM project_key_users WHERE project_id = p.id) as key_user_count
        FROM projects p
        LEFT JOIN systems s ON p.system_id = s.id
        ORDER BY p.status, p.name
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
    db.get(`
        SELECT p.*, s.name as system_name
        FROM projects p
        LEFT JOIN systems s ON p.system_id = s.id
        WHERE p.id = ?
    `, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Projekt nicht gefunden' });
        res.json(row);
    });
});

app.post('/api/projects', requireAuth, requireAdmin, (req, res) => {
    const { system_id, name, description, status, start_date, end_date } = req.body;
    db.run(`INSERT INTO projects (system_id, name, description, status, start_date, end_date)
            VALUES (?, ?, ?, ?, ?, ?)`,
        [system_id || null, name, description || '', status || 'planning', start_date || null, end_date || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        });
});

app.patch('/api/projects/:id', requireAuth, requireAdmin, (req, res) => {
    const allowed = ['system_id', 'name', 'description', 'status', 'start_date', 'end_date'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    updates.updated_at = new Date().toISOString();
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id];
    db.run(`UPDATE projects SET ${setClause} WHERE id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'updated' });
    });
});

// --- API: Milestones ---

function validateMilestoneStepPayload(body, partial = false) {
    const payload = body || {};
    const out = {};

    if (!partial || Object.prototype.hasOwnProperty.call(payload, 'title')) {
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (!title) return { error: 'title ist erforderlich' };
        out.title = title.slice(0, 160);
    }

    if (!partial || Object.prototype.hasOwnProperty.call(payload, 'text')) {
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return { error: 'text ist erforderlich' };
        out.text = text;
    }

    if (!partial || Object.prototype.hasOwnProperty.call(payload, 'date')) {
        const date = typeof payload.date === 'string' ? payload.date.trim() : '';
        if (!date) return { error: 'date ist erforderlich' };
        out.date = date;
    }

    return { value: out };
}

function serializeMilestoneBlob(blob) {
    return {
        id: blob.id,
        stepId: blob.step_id,
        filename: blob.filename,
        mimetype: blob.mimetype,
        size: blob.size,
        checksum: blob.checksum,
        createdAt: blob.created_at
    };
}

function serializeMilestoneStep(step, blobs) {
    return {
        id: step.id,
        milestoneId: step.milestone_id,
        title: step.title,
        text: step.text,
        date: step.date,
        createdAt: step.created_at,
        updatedAt: step.updated_at,
        blobs: (blobs || []).map(serializeMilestoneBlob)
    };
}

async function loadMilestoneStep(stepId, milestoneId) {
    const step = await dbGet('SELECT * FROM milestone_steps WHERE id = ? AND milestone_id = ?', [stepId, milestoneId]);
    if (!step.id) return null;
    const blobs = await dbAll('SELECT * FROM blobs WHERE step_id = ? ORDER BY created_at ASC, id ASC', [stepId]);
    return serializeMilestoneStep(step, blobs);
}

async function createMilestoneStepAttachments(stepId, files) {
    const created = [];
    for (const file of files || []) {
        const buffer = file.buffer;
        if (!buffer) continue;
        const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
        const result = await dbRun(`INSERT INTO blobs (step_id, filename, mimetype, size, checksum, data)
            VALUES (?, ?, ?, ?, ?, ?)`, [
            stepId,
            file.originalname || file.filename || 'attachment',
            file.mimetype || 'application/octet-stream',
            file.size || buffer.length,
            checksum,
            buffer
        ]);
        created.push({
            id: result.lastID,
            step_id: stepId,
            filename: file.originalname || file.filename || 'attachment',
            mimetype: file.mimetype || 'application/octet-stream',
            size: file.size || buffer.length,
            checksum,
            created_at: new Date().toISOString()
        });
    }
    return created;
}

app.get('/api/projects/:projectId/milestones', requireAuth, (req, res) => {
    db.all('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, start_date',
        [req.params.projectId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
});

app.post('/api/projects/:projectId/milestones', requireAuth, requireAdmin, (req, res) => {
    const { title, description, phase, start_date, end_date, status, color } = req.body;
    db.run(`INSERT INTO project_milestones (project_id, title, description, phase, start_date, end_date, status, color)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.params.projectId, title, description || '', phase || null, start_date || null, end_date || null, status || 'pending', color || '#2563eb'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('milestone:updated', { projectId: req.params.projectId });
            res.status(201).json({ id: this.lastID });
        });
});

app.patch('/api/milestones/:id', requireAuth, requireAdmin, (req, res) => {
    const allowed = ['title', 'description', 'phase', 'start_date', 'end_date', 'status', 'color', 'sort_order'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    updates.updated_at = new Date().toISOString();
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id];
    db.get('SELECT project_id FROM project_milestones WHERE id = ?', [req.params.id], (err, row) => {
        db.run(`UPDATE project_milestones SET ${setClause} WHERE id = ?`, values, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (row) io.emit('milestone:updated', { projectId: row.project_id });
            res.json({ status: 'updated' });
        });
    });
});

app.delete('/api/milestones/:id', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT project_id FROM project_milestones WHERE id = ?', [req.params.id], (err, row) => {
        db.run('DELETE FROM project_milestones WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (row) io.emit('milestone:updated', { projectId: row.project_id });
            res.json({ status: 'deleted' });
        });
    });
});

app.get('/api/milestones/:milestoneId/steps', requireAuth, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    if (!milestoneId) return res.status(400).json({ error: 'milestoneId ist erforderlich' });

    try {
        const milestone = await dbGet('SELECT id FROM project_milestones WHERE id = ?', [milestoneId]);
        if (!milestone.id) return res.status(404).json({ error: 'Meilenstein nicht gefunden' });

        const steps = await dbAll('SELECT * FROM milestone_steps WHERE milestone_id = ? ORDER BY date ASC, created_at ASC, id ASC', [milestoneId]);
        if (!steps.length) return res.json([]);

        const stepIds = steps.map(step => step.id);
        const placeholders = stepIds.map(() => '?').join(',');
        const blobs = await dbAll(`SELECT * FROM blobs WHERE step_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`, stepIds);
        const blobsByStep = new Map();
        blobs.forEach((blob) => {
            const list = blobsByStep.get(blob.step_id) || [];
            list.push(blob);
            blobsByStep.set(blob.step_id, list);
        });

        res.json(steps.map(step => serializeMilestoneStep(step, blobsByStep.get(step.id) || [])));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/milestones/:milestoneId/steps', requireAuth, requireAdmin, handleMilestoneStepUpload, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    if (!milestoneId) return res.status(400).json({ error: 'milestoneId ist erforderlich' });

    const validated = validateMilestoneStepPayload(req.body, false);
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
        const milestone = await dbGet('SELECT id, project_id FROM project_milestones WHERE id = ?', [milestoneId]);
        if (!milestone.id) return res.status(404).json({ error: 'Meilenstein nicht gefunden' });

        const result = await dbRun(`INSERT INTO milestone_steps (milestone_id, title, text, date)
            VALUES (?, ?, ?, ?)`, [milestoneId, validated.value.title, validated.value.text, validated.value.date]);
        await createMilestoneStepAttachments(result.lastID, req.files || []);
        io.emit('milestone:updated', { projectId: milestone.project_id });
        res.status(201).json(await loadMilestoneStep(result.lastID, milestoneId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/milestones/:milestoneId/steps/:stepId', requireAuth, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    const stepId = parseInt(req.params.stepId, 10);
    if (!milestoneId || !stepId) return res.status(400).json({ error: 'milestoneId und stepId sind erforderlich' });

    try {
        const step = await loadMilestoneStep(stepId, milestoneId);
        if (!step) return res.status(404).json({ error: 'Schritt nicht gefunden' });
        res.json(step);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/milestones/:milestoneId/steps/:stepId', requireAuth, requireAdmin, handleMilestoneStepUpload, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    const stepId = parseInt(req.params.stepId, 10);
    if (!milestoneId || !stepId) return res.status(400).json({ error: 'milestoneId und stepId sind erforderlich' });

    const validated = validateMilestoneStepPayload(req.body, true);
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
        const step = await dbGet('SELECT * FROM milestone_steps WHERE id = ? AND milestone_id = ?', [stepId, milestoneId]);
        if (!step.id) return res.status(404).json({ error: 'Schritt nicht gefunden' });

        const fields = [];
        const values = [];
        Object.entries(validated.value).forEach(([key, value]) => {
            fields.push(`${key} = ?`);
            values.push(value);
        });
        if (fields.length) {
            fields.push('updated_at = CURRENT_TIMESTAMP');
            await dbRun(`UPDATE milestone_steps SET ${fields.join(', ')} WHERE id = ? AND milestone_id = ?`, values.concat([stepId, milestoneId]));
        }
        await createMilestoneStepAttachments(stepId, req.files || []);
        res.json(await loadMilestoneStep(stepId, milestoneId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/milestones/:milestoneId/steps/:stepId', requireAuth, requireAdmin, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    const stepId = parseInt(req.params.stepId, 10);
    if (!milestoneId || !stepId) return res.status(400).json({ error: 'milestoneId und stepId sind erforderlich' });

    try {
        const milestone = await dbGet(`SELECT pm.project_id
            FROM milestone_steps ms
            INNER JOIN project_milestones pm ON pm.id = ms.milestone_id
            WHERE ms.id = ? AND ms.milestone_id = ?`, [stepId, milestoneId]);
        if (!milestone.project_id) return res.status(404).json({ error: 'Schritt nicht gefunden' });

        await dbRun('DELETE FROM blobs WHERE step_id = ?', [stepId]);
        await dbRun('DELETE FROM milestone_steps WHERE id = ? AND milestone_id = ?', [stepId, milestoneId]);
        io.emit('milestone:updated', { projectId: milestone.project_id });
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/milestones/:milestoneId/steps/:stepId/attachments/:blobId', requireAuth, async (req, res) => {
    const milestoneId = parseInt(req.params.milestoneId, 10);
    const stepId = parseInt(req.params.stepId, 10);
    const blobId = parseInt(req.params.blobId, 10);
    if (!milestoneId || !stepId || !blobId) {
        return res.status(400).json({ error: 'milestoneId, stepId und blobId sind erforderlich' });
    }

    try {
        const blob = await dbGet(`SELECT b.*
            FROM blobs b
            INNER JOIN milestone_steps ms ON ms.id = b.step_id
            WHERE b.id = ? AND b.step_id = ? AND ms.milestone_id = ?`, [blobId, stepId, milestoneId]);
        if (!blob.id) return res.status(404).json({ error: 'Anhang nicht gefunden' });

        const safeName = String(blob.filename || 'attachment').replace(/["\r\n]/g, '_');
        res.setHeader('Content-Type', blob.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Content-Length', blob.data ? blob.data.length : 0);
        res.send(blob.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: Key Users ---

app.get('/api/projects/:projectId/keyusers', requireAuth, (req, res) => {
    db.all(`
        SELECT k.*, s.name as staff_name, s.email as staff_email, s.phone as staff_phone
        FROM project_key_users k
        JOIN staff s ON k.staff_id = s.id
        WHERE k.project_id = ?
        ORDER BY k.role, s.name
    `, [req.params.projectId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/projects/:projectId/keyusers', requireAuth, requireAdmin, (req, res) => {
    const { staff_id, role, notes } = req.body;
    db.run(`INSERT INTO project_key_users (project_id, staff_id, role, notes) VALUES (?, ?, ?, ?)`,
        [req.params.projectId, staff_id, role || 'key_user', notes || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('keyuser:updated', { projectId: req.params.projectId });
            res.status(201).json({ id: this.lastID });
        });
});

app.delete('/api/keyusers/:id', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT project_id FROM project_key_users WHERE id = ?', [req.params.id], (err, row) => {
        db.run('DELETE FROM project_key_users WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (row) io.emit('keyuser:updated', { projectId: row.project_id });
            res.json({ status: 'deleted' });
        });
    });
});

// --- API: Documents ---

app.get('/api/projects/:projectId/docs', requireAuth, (req, res) => {
    db.all('SELECT * FROM project_documents WHERE project_id = ? ORDER BY sort_order, title',
        [req.params.projectId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
});

app.get('/api/projects/:projectId/docs/:slug', requireAuth, (req, res) => {
    db.get('SELECT * FROM project_documents WHERE project_id = ? AND slug = ?',
        [req.params.projectId, req.params.slug], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Dokument nicht gefunden' });
            res.json(row);
        });
});

app.post('/api/projects/:projectId/docs', requireAuth, requireAdmin, (req, res) => {
    const { title, slug, content } = req.body;
    db.run(`INSERT INTO project_documents (project_id, title, slug, content, updated_by) VALUES (?, ?, ?, ?, ?)`,
        [req.params.projectId, title, slug, content || '', getActor(req)],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        });
});

app.patch('/api/docs/:id', requireAuth, requireAdmin, (req, res) => {
    const allowed = ['title', 'slug', 'content', 'sort_order'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    updates.updated_at = new Date().toISOString();
    updates.updated_by = getActor(req);
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id];
    db.run(`UPDATE project_documents SET ${setClause} WHERE id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'updated' });
    });
});

app.delete('/api/docs/:id', requireAuth, requireAdmin, (req, res) => {
    db.run('DELETE FROM project_documents WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'deleted' });
    });
});

// --- API: GitHub Integration ---

app.get('/api/projects/:projectId/github', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT * FROM github_integration WHERE project_id = ?', [req.params.projectId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const result = row ? { ...row, access_token: row.access_token ? '***' : null } : null;
        res.json(result);
    });
});

app.post('/api/projects/:projectId/github', requireAuth, requireAdmin, (req, res) => {
    let { repo_owner, repo_name, access_token, webhook_secret, sync_issues, sync_wiki } = req.body;

    // Parse GitHub URL if user entered full URL in repo_name or repo_owner
    const urlMatch = (repo_owner || '').match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (urlMatch) {
        repo_owner = urlMatch[1];
        repo_name = repo_name || urlMatch[2];
    }
    const urlMatch2 = (repo_name || '').match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (urlMatch2) {
        repo_owner = urlMatch2[1];
        repo_name = urlMatch2[2];
    }

    if (!repo_owner || !repo_name) {
        return res.status(400).json({ error: 'Repository Owner und Name sind erforderlich.' });
    }

    db.get('SELECT id FROM github_integration WHERE project_id = ?', [req.params.projectId], (err, existing) => {
        if (existing) {
            const fields = [];
            const vals = [];
            if (repo_owner !== undefined) { fields.push('repo_owner = ?'); vals.push(repo_owner); }
            if (repo_name !== undefined) { fields.push('repo_name = ?'); vals.push(repo_name); }
            if (access_token !== undefined) { fields.push('access_token = ?'); vals.push(access_token); }
            if (webhook_secret !== undefined) { fields.push('webhook_secret = ?'); vals.push(webhook_secret); }
            if (sync_issues !== undefined) { fields.push('sync_issues = ?'); vals.push(sync_issues); }
            if (sync_wiki !== undefined) { fields.push('sync_wiki = ?'); vals.push(sync_wiki); }
            vals.push(req.params.projectId);
            db.run(`UPDATE github_integration SET ${fields.join(', ')} WHERE project_id = ?`, vals, function(e) {
                if (e) return res.status(500).json({ error: e.message });
                res.json({ status: 'updated' });
            });
        } else {
            db.run(`INSERT INTO github_integration (project_id, repo_owner, repo_name, access_token, webhook_secret, sync_issues, sync_wiki)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [req.params.projectId, repo_owner, repo_name, access_token, webhook_secret || null, sync_issues || 1, sync_wiki || 0],
                function(e) {
                    if (e) return res.status(500).json({ error: e.message });
                    res.status(201).json({ id: this.lastID });
                });
        }
    });
});

async function syncGitHubIssues(projectId, integration) {
    const octokit = new Octokit({ auth: integration.access_token });
    let allIssues = [];
    let page = 1;
    while (true) {
        const { data: issues } = await octokit.rest.issues.listForRepo({
            owner: integration.repo_owner,
            repo: integration.repo_name,
            state: 'all',
            per_page: 100,
            page: page
        });
        allIssues = allIssues.concat(issues);
        if (issues.length < 100) break;
        page++;
    }
    for (const issue of allIssues) {
        if (issue.pull_request) continue;
        db.run(`INSERT OR REPLACE INTO github_issues
            (project_id, issue_number, title, state, html_url, labels, github_created_at, github_updated_at, github_user, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [projectId, issue.number, issue.title, issue.state, issue.html_url,
             JSON.stringify(issue.labels.map(l => l.name)), issue.created_at, issue.updated_at, issue.user?.login]);
    }
    return allIssues.filter(i => !i.pull_request).length;
}

async function syncGitHubWiki(projectId, integration) {
    const octokit = new Octokit({ auth: integration.access_token });
    try {
        const { data: pages } = await octokit.request('GET /repos/{owner}/{repo}/wiki', {
            owner: integration.repo_owner,
            repo: integration.repo_name,
            headers: { accept: 'application/vnd.github+json' }
        });
        for (const page of pages) {
            db.run(`INSERT OR IGNORE INTO project_documents (project_id, title, slug, content, updated_by)
                    VALUES (?, ?, ?, ?, ?)`,
                [projectId, page.title, page.title.toLowerCase().replace(/\s+/g, '-'),
                 page.body || '# Von GitHub Wiki importiert\n\nInhalt muss manuell synchronisiert werden.',
                 'GitHub-Wiki']);
        }
        return pages.length;
    } catch (e) {
        console.error('Wiki sync error:', e.message);
        return 0;
    }
}

app.post('/api/projects/:projectId/github/sync', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT * FROM github_integration WHERE project_id = ?', [req.params.projectId], async (err, integration) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!integration) return res.status(400).json({ error: 'GitHub-Integration nicht konfiguriert. Bitte zuerst Repository hinterlegen.' });
        if (!integration.access_token) return res.status(400).json({ error: 'Kein Access Token konfiguriert. Bitte Personal Access Token hinterlegen.' });
        try {
            const octokit = new Octokit({ auth: integration.access_token });
            try {
                await octokit.rest.repos.get({ owner: integration.repo_owner, repo: integration.repo_name });
            } catch (repoErr) {
                if (repoErr.status === 404) return res.status(400).json({ error: 'Repository nicht gefunden: ' + integration.repo_owner + '/' + integration.repo_name + '. Prüfe Owner und Repo-Name.' });
                if (repoErr.status === 401) return res.status(400).json({ error: 'Access Token ungültig oder abgelaufen.' });
                if (repoErr.status === 403) return res.status(400).json({ error: 'Zugriff verweigert. Token benötigt repo-Scope oder Repository ist privat.' });
                return res.status(500).json({ error: 'Verbindungstest fehlgeschlagen: ' + repoErr.message });
            }
            let issuesCount = 0, wikiPages = 0;
            if (integration.sync_issues) {
                issuesCount = await syncGitHubIssues(req.params.projectId, integration);
            }
            if (integration.sync_wiki) {
                wikiPages = await syncGitHubWiki(req.params.projectId, integration);
            }
            db.run('UPDATE github_integration SET last_synced_at = CURRENT_TIMESTAMP WHERE project_id = ?', [req.params.projectId]);
            res.json({ status: 'synced', issues_count: issuesCount, wiki_pages: wikiPages });
        } catch (e) {
            res.status(500).json({ error: 'GitHub-Sync fehlgeschlagen: ' + e.message });
        }
    });
});

app.get('/api/projects/:projectId/github/issues', requireAuth, (req, res) => {
    db.get('SELECT * FROM github_integration WHERE project_id = ?', [req.params.projectId], async (err, integration) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!integration || !integration.access_token) return res.json([]);
        try {
            const octokit = new Octokit({ auth: integration.access_token });
            const { data: issues } = await octokit.rest.issues.listForRepo({
                owner: integration.repo_owner,
                repo: integration.repo_name,
                state: 'open',
                per_page: 50
            });
            const result = issues.filter(i => !i.pull_request).map(i => ({
                number: i.number,
                title: i.title,
                state: i.state,
                html_url: i.html_url,
                labels: i.labels.map(l => l.name),
                created_at: i.created_at,
                updated_at: i.updated_at,
                user: i.user?.login
            }));
            // Cache in local DB
            for (const issue of result) {
                db.run(`INSERT OR REPLACE INTO github_issues
                    (project_id, issue_number, title, state, html_url, labels, github_created_at, github_updated_at, github_user, synced_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [req.params.projectId, issue.number, issue.title, issue.state, issue.html_url,
                     JSON.stringify(issue.labels), issue.created_at, issue.updated_at, issue.user]);
            }
            res.json(result);
        } catch (e) {
            // Fallback: return cached issues
            db.all('SELECT * FROM github_issues WHERE project_id = ? ORDER BY github_updated_at DESC', [req.params.projectId], (err2, cached) => {
                if (err2) return res.status(500).json({ error: e.message });
                res.json(cached.map(r => ({
                    number: r.issue_number,
                    title: r.title,
                    state: r.state,
                    html_url: r.html_url,
                    labels: JSON.parse(r.labels || '[]'),
                    created_at: r.github_created_at,
                    updated_at: r.github_updated_at,
                    user: r.github_user,
                    _cached: true
                })));
            });
        }
    });
});

app.get('/api/projects/:projectId/github/milestones', requireAuth, (req, res) => {
    db.get('SELECT * FROM github_integration WHERE project_id = ?', [req.params.projectId], async (err, integration) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!integration || !integration.access_token) return res.json([]);
        try {
            const octokit = new Octokit({ auth: integration.access_token });
            const { data: milestones } = await octokit.rest.issues.listMilestones({
                owner: integration.repo_owner,
                repo: integration.repo_name,
                state: 'all',
                per_page: 50
            });
            res.json(milestones);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// Markdown render helper
app.post('/api/markdown/render', requireAuth, (req, res) => {
    try {
        const html = marked.parse(req.body.text || '');
        res.json({ html });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Web UI: Systems ---

app.get('/admin/systems', requireAuth, requireAdmin, (req, res) => {
    db.all('SELECT * FROM systems WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).send('DB Error');
        res.render('systems', {
            systems: (rows || []).map(row => ({
                id: row.id,
                name: row.name,
                description: row.description,
                repo_owner: row.repo_owner,
                repo_name: row.repo_name,
                ai_workflow_enabled: row.ai_workflow_enabled,
                repo_url: row.repo_owner && row.repo_name ? `https://github.com/${row.repo_owner}/${row.repo_name}` : ''
            })),
            user: req.session.user,
            role: req.session.role || 'user'
        });
    });
});

app.post('/admin/systems', requireAuth, requireAdmin, (req, res) => {
    const data = parseSystemPayload(req.body);
    if (!data.name) return res.status(400).send('Name ist erforderlich.');
    db.run(`INSERT INTO systems (name, description, repo_owner, repo_name, repo_access_token, repo_webhook_secret, ai_workflow_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.name, data.description, data.repo_owner, data.repo_name, data.repo_access_token, data.repo_webhook_secret, data.ai_workflow_enabled], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/systems');
    });
});

app.post('/admin/systems/:id/update', requireAuth, requireAdmin, (req, res) => {
    const data = parseSystemPayload(req.body);
    if (!data.name) return res.status(400).send('Name ist erforderlich.');
    db.run(`UPDATE systems SET
            name = ?, description = ?, repo_owner = ?, repo_name = ?,
            repo_access_token = COALESCE(?, repo_access_token),
            repo_webhook_secret = COALESCE(?, repo_webhook_secret),
            ai_workflow_enabled = ?
            WHERE id = ?`,
    [data.name, data.description, data.repo_owner, data.repo_name, data.repo_access_token, data.repo_webhook_secret, data.ai_workflow_enabled, req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/systems');
    });
});

app.post('/admin/systems/:id/delete', requireAuth, requireAdmin, (req, res) => {
    db.run('UPDATE systems SET active = 0 WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/systems');
    });
});

const WORKFLOW_ROLES = ['triage', 'security', 'planning', 'integration', 'approval', 'coding', 'clarifier'];
const WORKFLOW_ROLE_LABELS = {
    triage: 'Triage Reviewer',
    security: 'Security & Privacy Reviewer',
    planning: 'Solution Architect (Planner)',
    integration: 'Integration / Architecture Reviewer',
    approval: 'Final Approver',
    coding: 'Coding Bot',
    clarifier: 'Repo-Resolver (Clarifier)'
};
const CODING_LEVELS = ['medium', 'high'];
const CODING_LEVEL_LABELS = {
    medium: 'Medium (GPT-5.4 / DeepSeek V4 / Kimi 2.6 Niveau)',
    high: 'High (Opus 4.7 / GPT-5.5 Niveau)'
};
const AI_PROVIDERS = ['deepseek', 'ollama', 'openai', 'openai_local', 'anthropic', 'copilot', 'mistral', 'openrouter', 'clarifai'];

function parseRepoInput(repoUrlOrOwner, repoNameRaw) {
    let repo_owner = repoUrlOrOwner ? String(repoUrlOrOwner).trim() : '';
    let repo_name = repoNameRaw ? String(repoNameRaw).trim() : '';

    const urlMatch = repo_owner.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/i);
    if (urlMatch) {
        repo_owner = urlMatch[1];
        repo_name = repo_name || urlMatch[2];
    }
    const urlMatch2 = repo_name.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/i);
    if (urlMatch2) {
        repo_owner = urlMatch2[1];
        repo_name = urlMatch2[2];
    }

    repo_owner = repo_owner.replace(/^https?:\/\//i, '').trim() || null;
    repo_name = repo_name ? repo_name.replace(/\.git$/i, '').trim() : null;
    return { repo_owner, repo_name: repo_name || null };
}

function parseSystemPayload(body) {
    const parsedRepo = parseRepoInput(body.repo_url || body.repo_owner, body.repo_name);
    return {
        name: normalizeText(body.name, 200),
        description: body.description ? normalizeText(body.description, 1000) : null,
        repo_owner: parsedRepo.repo_owner,
        repo_name: parsedRepo.repo_name,
        repo_access_token: body.repo_access_token ? String(body.repo_access_token).trim() : null,
        repo_webhook_secret: body.repo_webhook_secret ? String(body.repo_webhook_secret).trim() : null,
        ai_workflow_enabled: parseCheckbox(body.ai_workflow_enabled, true) ? 1 : 0
    };
}

function parseStaffPayload(body) {
    const kind = body.kind === 'ai' ? 'ai' : 'human';
    const ai_provider = kind === 'ai' && AI_PROVIDERS.includes(body.ai_provider) ? body.ai_provider : null;
    const ai_model = kind === 'ai' && body.ai_model ? String(body.ai_model).trim().slice(0, 200) : null;
    let temp = parseFloat(body.ai_temperature);
    if (Number.isNaN(temp) || temp < 0) temp = 0.2;
    if (temp > 2) temp = 2;
    const ai_max_tokens = kind === 'ai' && body.ai_max_tokens ? Math.max(0, parseInt(body.ai_max_tokens, 10)) || null : null;
    const ai_system_prompt = kind === 'ai' && body.ai_system_prompt ? String(body.ai_system_prompt).slice(0, 8000) : null;
    let ai_extra_config = null;
    if (kind === 'ai' && body.ai_extra_config) {
        const raw = String(body.ai_extra_config).trim();
        if (raw) {
            try { JSON.parse(raw); ai_extra_config = raw; } catch (_) { ai_extra_config = null; }
        }
    }
    return {
        name: normalizeText(body.name, 200),
        email: normalizeText(body.email, 320),
        phone: body.phone ? normalizeText(body.phone, 80) : null,
        kind,
        ai_provider,
        ai_model,
        ai_temperature: kind === 'ai' ? temp : null,
        ai_max_tokens,
        ai_system_prompt,
        ai_extra_config,
        coding_level: kind === 'ai' && CODING_LEVELS.includes(body.coding_level) ? body.coding_level : null,
        auto_commit_enabled: body.auto_commit_enabled ? 1 : 0
    };
}

function normalizeRolesInput(body) {
    let roles = body.roles;
    if (!Array.isArray(roles)) roles = roles ? [roles] : [];
    return Array.from(new Set(roles.filter(r => WORKFLOW_ROLES.includes(r))));
}

function normalizeSystemAssignmentsInput(body) {
    let systems = body.system_ids;
    if (!Array.isArray(systems)) systems = systems ? [systems] : [];
    let primary = body.primary_system_ids;
    if (!Array.isArray(primary)) primary = primary ? [primary] : [];

    const systemIds = Array.from(new Set(systems
        .map(v => parseInt(v, 10))
        .filter(v => Number.isInteger(v) && v > 0)));
    const primarySet = new Set(primary
        .map(v => parseInt(v, 10))
        .filter(v => Number.isInteger(v) && v > 0));

    return systemIds.map(systemId => ({ system_id: systemId, is_primary: primarySet.has(systemId) ? 1 : 0 }));
}

function replaceStaffRoles(staffId, roles, callback) {
    db.serialize(() => {
        db.run('DELETE FROM staff_roles WHERE staff_id = ?', [staffId], (err) => {
            if (err) return callback(err);
            if (roles.length === 0) return callback(null);
            const stmt = db.prepare('INSERT OR IGNORE INTO staff_roles (staff_id, role, priority, active) VALUES (?, ?, 100, 1)');
            roles.forEach(role => stmt.run(staffId, role));
            stmt.finalize(callback);
        });
    });
}

function replaceStaffSystemAssignments(staffId, assignments, callback) {
    db.serialize(() => {
        db.run('DELETE FROM staff_system_assignments WHERE staff_id = ?', [staffId], (err) => {
            if (err) return callback(err);
            if (!assignments || assignments.length === 0) return callback(null);
            const stmt = db.prepare(`INSERT OR REPLACE INTO staff_system_assignments
                (staff_id, system_id, is_primary, active)
                VALUES (?, ?, ?, 1)`);
            assignments.forEach(a => stmt.run(staffId, a.system_id, a.is_primary ? 1 : 0));
            stmt.finalize(callback);
        });
    });
}

function loadStaffWithRoles(callback) {
    db.all(`SELECT s.*, GROUP_CONCAT(sr.role) AS role_list
        FROM staff s
        LEFT JOIN staff_roles sr ON sr.staff_id = s.id AND sr.active = 1
        WHERE s.active = 1
        GROUP BY s.id
        ORDER BY s.name`, [], (err, rows) => {
        if (err) return callback(err);
        rows.forEach(r => { r.roles = r.role_list ? r.role_list.split(',') : []; delete r.role_list; });
        const ids = rows.map(r => r.id);
        if (!ids.length) return callback(null, rows);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT ssa.staff_id, ssa.system_id, ssa.is_primary, sys.name AS system_name
            FROM staff_system_assignments ssa
            INNER JOIN systems sys ON sys.id = ssa.system_id
            WHERE ssa.active = 1 AND ssa.staff_id IN (${placeholders})
            ORDER BY sys.name`, ids, (assignErr, assignments) => {
            if (assignErr) return callback(assignErr);
            const byStaff = new Map();
            (assignments || []).forEach(a => {
                if (!byStaff.has(a.staff_id)) byStaff.set(a.staff_id, []);
                byStaff.get(a.staff_id).push({
                    system_id: a.system_id,
                    system_name: a.system_name,
                    is_primary: !!a.is_primary
                });
            });
            rows.forEach(r => {
                r.system_assignments = byStaff.get(r.id) || [];
            });
            callback(null, rows);
        });
    });
}

app.get('/admin/staff', requireAuth, requireAdmin, (req, res) => {
    loadStaffWithRoles((err, rows) => {
        if (err) return res.status(500).send('DB Error');
        db.all('SELECT id, name FROM systems WHERE active = 1 ORDER BY name', [], (sysErr, systems) => {
            if (sysErr) return res.status(500).send('DB Error');
            res.render('staff', {
                staff: rows,
                systems: systems || [],
                user: req.session.user,
                role: req.session.role || 'user',
                workflowRoles: WORKFLOW_ROLES,
                workflowRoleLabels: WORKFLOW_ROLE_LABELS,
                codingLevels: CODING_LEVELS,
                codingLevelLabels: CODING_LEVEL_LABELS,
                aiProviders: AI_PROVIDERS
            });
        });
    });
});

app.post('/admin/staff', requireAuth, requireAdmin, (req, res) => {
    const data = parseStaffPayload(req.body);
    if (!data.name || !data.email) return res.status(400).send('Name und E-Mail sind erforderlich.');
    const roles = normalizeRolesInput(req.body);
    const systemAssignments = data.kind === 'human' ? normalizeSystemAssignmentsInput(req.body) : [];
    db.run(`INSERT INTO staff
            (name, email, phone, kind, ai_provider, ai_model, ai_temperature, ai_system_prompt, ai_max_tokens, ai_extra_config)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.name, data.email, data.phone, data.kind, data.ai_provider, data.ai_model,
         data.ai_temperature, data.ai_system_prompt, data.ai_max_tokens, data.ai_extra_config],
        function(err) {
            if (err) return res.status(500).send('DB Error');
            replaceStaffRoles(this.lastID, roles, (rolesErr) => {
                if (rolesErr) console.error('Fehler beim Setzen der Rollen:', rolesErr.message);
                replaceStaffSystemAssignments(this.lastID, systemAssignments, (sysErr) => {
                    if (sysErr) console.error('Fehler beim Setzen der Systeme:', sysErr.message);
                    res.redirect('/admin/staff');
                });
            });
        });
});

app.post('/admin/staff/:id/update', requireAuth, requireAdmin, (req, res) => {
    const data = parseStaffPayload(req.body);
    if (!data.name || !data.email) return res.status(400).send('Name und E-Mail sind erforderlich.');
    const roles = normalizeRolesInput(req.body);
    const systemAssignments = data.kind === 'human' ? normalizeSystemAssignmentsInput(req.body) : [];
    db.run(`UPDATE staff SET
            name = ?, email = ?, phone = ?, kind = ?, ai_provider = ?, ai_model = ?,
            ai_temperature = ?, ai_system_prompt = ?, ai_max_tokens = ?, ai_extra_config = ?,
            coding_level = ?, auto_commit_enabled = ?
            WHERE id = ?`,
        [data.name, data.email, data.phone, data.kind, data.ai_provider, data.ai_model,
         data.ai_temperature, data.ai_system_prompt, data.ai_max_tokens, data.ai_extra_config,
         data.coding_level, data.auto_commit_enabled, req.params.id],
        (err) => {
            if (err) return res.status(500).send('DB Error');
            replaceStaffRoles(req.params.id, roles, (rolesErr) => {
                if (rolesErr) console.error('Fehler beim Setzen der Rollen:', rolesErr.message);
                replaceStaffSystemAssignments(req.params.id, systemAssignments, (sysErr) => {
                    if (sysErr) console.error('Fehler beim Setzen der Systeme:', sysErr.message);
                    res.redirect('/admin/staff');
                });
            });
        });
});

app.post('/admin/staff/:id/delete', requireAuth, requireAdmin, (req, res) => {
    db.run('UPDATE staff SET active = 0 WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/staff');
    });
});

// --- Web UI: User Management (root only) ---

app.get('/admin/users', requireAuth, requireRoot, (req, res) => {
    db.all(`SELECT u.*, s.name as staff_name, sys.name as system_name
        FROM users u
        LEFT JOIN staff s ON u.staff_id = s.id
        LEFT JOIN systems sys ON u.default_system_id = sys.id
        WHERE u.active = 1 ORDER BY u.username`, [], (err, users) => {
        if (err) return res.status(500).send('DB Error');
        db.all('SELECT * FROM staff WHERE active = 1 ORDER BY name', [], (err, staffList) => {
            db.all('SELECT * FROM systems WHERE active = 1 ORDER BY name', [], (err, systems) => {
                res.render('users', {
                    users: users || [],
                    staffList: staffList || [],
                    systems: systems || [],
                    user: req.session.user,
                    role: req.session.role,
                    error: req.query.error || null
                });
            });
        });
    });
});

app.post('/admin/users', requireAuth, requireRoot, (req, res) => {
    const { username, password, role, staff_id, default_system_id } = req.body;
    if (!username || !password) return res.redirect('/admin/users?error=Benutzername+und+Passwort+erforderlich');
    const hash = hashPassword(password);
    const staffId = staff_id ? parseInt(staff_id, 10) : null;
    const sysId = default_system_id ? parseInt(default_system_id, 10) : null;
    const notifyNewTickets = parseCheckbox(req.body.notify_new_tickets);
    const notifyAssignedTickets = parseCheckbox(req.body.notify_assigned_tickets);
    const notifyStatusChanges = parseCheckbox(req.body.notify_status_changes);
    db.run(`INSERT INTO users (
            username, password_hash, role, staff_id, default_system_id,
            notify_new_tickets, notify_assigned_tickets, notify_status_changes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, hash, role || 'user', staffId, sysId, notifyNewTickets, notifyAssignedTickets, notifyStatusChanges],
        function(err) {
            if (err) {
                const msg = err.message.includes('UNIQUE') ? 'Benutzername+bereits+vergeben' : 'DB+Fehler';
                return res.redirect('/admin/users?error=' + msg);
            }
            res.redirect('/admin/users');
        });
});

app.post('/admin/users/:id/update', requireAuth, requireRoot, (req, res) => {
    const { role, staff_id, default_system_id, password } = req.body;
    const staffId = staff_id ? parseInt(staff_id, 10) : null;
    const sysId = default_system_id ? parseInt(default_system_id, 10) : null;
    const notifyNewTickets = parseCheckbox(req.body.notify_new_tickets);
    const notifyAssignedTickets = parseCheckbox(req.body.notify_assigned_tickets);
    const notifyStatusChanges = parseCheckbox(req.body.notify_status_changes);
    if (password) {
        const hash = hashPassword(password);
        db.run(`UPDATE users SET role = ?, staff_id = ?, default_system_id = ?,
            notify_new_tickets = ?, notify_assigned_tickets = ?, notify_status_changes = ?, password_hash = ?
            WHERE id = ?`,
            [role, staffId, sysId, notifyNewTickets, notifyAssignedTickets, notifyStatusChanges, hash, req.params.id], (err) => {
                if (err) return res.status(500).send('DB Error');
                res.redirect('/admin/users');
            });
    } else {
        db.run(`UPDATE users SET role = ?, staff_id = ?, default_system_id = ?,
            notify_new_tickets = ?, notify_assigned_tickets = ?, notify_status_changes = ?
            WHERE id = ?`,
            [role, staffId, sysId, notifyNewTickets, notifyAssignedTickets, notifyStatusChanges, req.params.id], (err) => {
                if (err) return res.status(500).send('DB Error');
                res.redirect('/admin/users');
            });
    }
});

app.post('/admin/users/:id/delete', requireAuth, requireRoot, (req, res) => {
    db.run('UPDATE users SET active = 0 WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/users');
    });
});

app.get('/account', requireAuth, (req, res) => {
    loadCurrentUserAccount(req, (err, account) => {
        if (err) return res.status(500).send('DB Error');
        res.render('account', {
            user: req.session.user,
            role: req.session.role || 'user',
            account: account || null,
            error: req.query.error || null,
            success: req.query.success || null,
            isRootAccount: req.session.role === 'root' && !account
        });
    });
});

app.post('/account', requireAuth, (req, res) => {
    const { email, password, password_confirm } = req.body;

    if (password && password !== password_confirm) {
        return res.redirect('/account?error=Passworteingaben+stimmen+nicht+ueberein');
    }

    loadCurrentUserAccount(req, (err, account) => {
        if (err) return res.status(500).send('DB Error');

        if (!account) {
            if (req.session.role === 'root') {
                return res.redirect('/account?error=Das+Root-Konto+wird+ueber+Umgebungsvariablen+verwaltet');
            }
            return res.redirect('/account?error=Benutzerkonto+nicht+gefunden');
        }

        const updates = [];
        const afterPasswordUpdate = () => {
            if (!account.staff_id) {
                return res.redirect('/account?success=Passwort+aktualisiert');
            }

            if (!email || email === account.staff_email) {
                return res.redirect('/account?success=Account+aktualisiert');
            }

            db.run('UPDATE staff SET email = ? WHERE id = ?', [email.trim(), account.staff_id], (staffErr) => {
                if (staffErr) return res.status(500).send('DB Error');
                res.redirect('/account?success=Account+aktualisiert');
            });
        };

        if (password) {
            updates.push((done) => {
                db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), account.id], (passwordErr) => {
                    if (passwordErr) return done(passwordErr);
                    done(null);
                });
            });
        }

        const trimmedEmail = email ? email.trim() : '';
        if (account.staff_id && !trimmedEmail) {
            return res.redirect('/account?error=E-Mail+darf+nicht+leer+sein');
        }

        if (updates.length === 0) {
            if (!account.staff_id) {
                return res.redirect('/account?error=Keine+Aenderungen+zum+Speichern');
            }

            if (trimmedEmail === account.staff_email) {
                return res.redirect('/account?error=Keine+Aenderungen+zum+Speichern');
            }
        }

        if (updates.length === 0) {
            return afterPasswordUpdate();
        }

        updates[0]((updateErr) => {
            if (updateErr) return res.status(500).send('DB Error');
            afterPasswordUpdate();
        });
    });
});

app.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    const nowIso = new Date().toISOString();
    const allowedPeriods = new Set(['daily', 'monthly', 'yearly', 'all']);
    const selectedPeriod = allowedPeriods.has(String(req.query.period || 'all')) ? String(req.query.period || 'all') : 'all';

    function buildPeriodFilter(period, column) {
        if (period === 'daily') return { clause: ` AND date(${column}) = date('now')`, params: [] };
        if (period === 'monthly') return { clause: ` AND date(${column}) >= date('now', 'start of month')`, params: [] };
        if (period === 'yearly') return { clause: ` AND date(${column}) >= date('now', 'start of year')`, params: [] };
        return { clause: '', params: [] };
    }

    const ticketPeriod = buildPeriodFilter(selectedPeriod, 't.created_at');
    const ticketPeriodRaw = buildPeriodFilter(selectedPeriod, 'created_at');

    try {
        const [
            totals,
            byStatus,
            byPriority,
            bySystem,
            byStaff,
            responseStats,
            slaOverview,
            feedbackStats,
            weeklyTrend,
            monthlyTrend,
            yearlyTrend,
            agingBuckets,
            unassignedTickets,
            overdueSlaTickets,
            longestOpenTickets,
            busiestCreators
        ] = await Promise.all([
            dbGet(`SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status != 'geschlossen' THEN 1 ELSE 0 END) AS open_total,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed_total,
                SUM(CASE WHEN deadline IS NOT NULL AND status != 'geschlossen' AND deadline < ? THEN 1 ELSE 0 END) AS overdue_deadline,
                SUM(CASE WHEN assigned_to IS NULL AND status != 'geschlossen' THEN 1 ELSE 0 END) AS unassigned_open
                FROM tickets WHERE 1=1${ticketPeriodRaw.clause}`, [nowIso, ...ticketPeriodRaw.params]),
            dbAll(`SELECT status, COUNT(*) AS count FROM tickets WHERE 1=1${ticketPeriodRaw.clause} GROUP BY status ORDER BY count DESC`, ticketPeriodRaw.params),
            dbAll(`SELECT priority, COUNT(*) AS count FROM tickets WHERE 1=1${ticketPeriodRaw.clause} GROUP BY priority ORDER BY
                CASE priority WHEN 'kritisch' THEN 1 WHEN 'hoch' THEN 2 WHEN 'mittel' THEN 3 WHEN 'niedrig' THEN 4 ELSE 5 END`, ticketPeriodRaw.params),
            dbAll(`SELECT COALESCE(s.name, 'Ohne System') AS name,
                COUNT(t.id) AS total,
                SUM(CASE WHEN t.status != 'geschlossen' THEN 1 ELSE 0 END) AS open_total,
                SUM(CASE WHEN t.status = 'geschlossen' THEN 1 ELSE 0 END) AS closed_total,
                ROUND(AVG(CASE WHEN COALESCE(ts.first_response_at, t.first_responded_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.first_response_at, t.first_responded_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_response_minutes,
                ROUND(AVG(CASE WHEN COALESCE(ts.resolution_at, t.closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.resolution_at, t.closed_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                LEFT JOIN ticket_sla ts ON ts.ticket_id = t.id
                WHERE 1=1${ticketPeriod.clause}
                GROUP BY COALESCE(s.name, 'Ohne System')
                ORDER BY total DESC, name ASC`, ticketPeriod.params),
            dbAll(`SELECT COALESCE(st.name, 'Nicht zugewiesen') AS name,
                COUNT(t.id) AS total,
                SUM(CASE WHEN t.status != 'geschlossen' THEN 1 ELSE 0 END) AS open_total,
                SUM(CASE WHEN t.status = 'geschlossen' THEN 1 ELSE 0 END) AS closed_total,
                SUM(CASE WHEN t.status != 'geschlossen' AND t.deadline IS NOT NULL AND t.deadline < ? THEN 1 ELSE 0 END) AS overdue_total,
                ROUND(AVG(CASE WHEN COALESCE(ts.first_response_at, t.first_responded_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.first_response_at, t.first_responded_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_response_minutes,
                ROUND(AVG(CASE WHEN COALESCE(ts.resolution_at, t.closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.resolution_at, t.closed_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets t
                LEFT JOIN staff st ON t.assigned_to = st.id
                LEFT JOIN ticket_sla ts ON ts.ticket_id = t.id
                WHERE 1=1${ticketPeriod.clause}
                GROUP BY COALESCE(st.name, 'Nicht zugewiesen')
                ORDER BY total DESC, name ASC`, [nowIso, ...ticketPeriod.params]),
            dbGet(`SELECT
                ROUND(AVG(CASE WHEN COALESCE(ts.first_response_at, t.first_responded_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.first_response_at, t.first_responded_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_response_minutes,
                ROUND(AVG(CASE WHEN COALESCE(ts.resolution_at, t.closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.resolution_at, t.closed_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes,
                ROUND(AVG(CASE WHEN t.status != 'geschlossen'
                    THEN (julianday('now') - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_open_age_minutes,
                ROUND(AVG(CASE WHEN t.status = 'geschlossen' AND COALESCE(ts.resolution_at, t.closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(ts.resolution_at, t.closed_at)) - julianday(t.created_at)) * 24 * 60 END), 0) AS avg_closed_cycle_minutes
                FROM tickets t
                LEFT JOIN ticket_sla ts ON ts.ticket_id = t.id
                WHERE 1=1${ticketPeriod.clause}`, ticketPeriod.params),
            dbGet(`SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS responses_done,
                SUM(CASE WHEN resolution_at IS NOT NULL THEN 1 ELSE 0 END) AS resolutions_done,
                SUM(CASE WHEN first_response_at IS NOT NULL AND first_response_due IS NOT NULL AND first_response_at <= first_response_due THEN 1 ELSE 0 END) AS responses_in_time,
                SUM(CASE WHEN resolution_at IS NOT NULL AND resolution_due IS NOT NULL AND resolution_at <= resolution_due THEN 1 ELSE 0 END) AS resolutions_in_time,
                SUM(CASE WHEN first_response_at IS NULL AND first_response_due IS NOT NULL AND first_response_due < ? THEN 1 ELSE 0 END) AS pending_response_breached,
                SUM(CASE WHEN resolution_at IS NULL AND resolution_due IS NOT NULL AND resolution_due < ? THEN 1 ELSE 0 END) AS pending_resolution_breached
                FROM ticket_sla ts
                INNER JOIN tickets t ON t.id = ts.ticket_id
                WHERE 1=1${ticketPeriod.clause}`, [nowIso, nowIso, ...ticketPeriod.params]),
            dbGet(`SELECT ROUND(AVG(rating), 2) AS avg_rating, COUNT(*) AS count
                FROM ticket_feedback tf
                INNER JOIN tickets t ON t.id = tf.ticket_id
                WHERE 1=1${ticketPeriod.clause}`, ticketPeriod.params),
            dbAll(`SELECT strftime('%Y-W%W', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                WHERE created_at >= date('now', '-12 weeks')${ticketPeriodRaw.clause}
                GROUP BY period
                ORDER BY period DESC
                LIMIT 12`, ticketPeriodRaw.params),
            dbAll(`SELECT strftime('%Y-%m', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                WHERE created_at >= date('now', '-12 months')${ticketPeriodRaw.clause}
                GROUP BY period
                ORDER BY period DESC
                LIMIT 12`, ticketPeriodRaw.params),
            dbAll(`SELECT strftime('%Y', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                WHERE 1=1${ticketPeriodRaw.clause}
                GROUP BY period
                ORDER BY period DESC
                LIMIT 5`, ticketPeriodRaw.params),
            dbAll(`SELECT bucket, COUNT(*) AS count FROM (
                    SELECT CASE
                        WHEN (julianday('now') - julianday(created_at)) < 1 THEN '< 1 Tag'
                        WHEN (julianday('now') - julianday(created_at)) < 3 THEN '1-3 Tage'
                        WHEN (julianday('now') - julianday(created_at)) < 7 THEN '3-7 Tage'
                        WHEN (julianday('now') - julianday(created_at)) < 14 THEN '7-14 Tage'
                        ELSE '> 14 Tage'
                    END AS bucket
                    FROM tickets
                    WHERE status != 'geschlossen'${ticketPeriodRaw.clause}
                ) grouped
                GROUP BY bucket
                ORDER BY CASE bucket WHEN '< 1 Tag' THEN 1 WHEN '1-3 Tage' THEN 2 WHEN '3-7 Tage' THEN 3 WHEN '7-14 Tage' THEN 4 ELSE 5 END`, ticketPeriodRaw.params),
            dbAll(`SELECT t.id, t.title, t.priority, t.status, t.created_at, s.name AS system_name
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                WHERE t.assigned_to IS NULL AND t.status != 'geschlossen'${ticketPeriod.clause}
                ORDER BY t.created_at ASC
                LIMIT 10`, ticketPeriod.params),
            dbAll(`SELECT t.id, t.title, t.priority, t.status, t.created_at, t.deadline, s.name AS system_name, st.name AS assigned_name,
                    ts.first_response_due, ts.resolution_due
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                LEFT JOIN staff st ON t.assigned_to = st.id
                LEFT JOIN ticket_sla ts ON ts.ticket_id = t.id
                WHERE t.status != 'geschlossen' AND (
                    (ts.first_response_at IS NULL AND ts.first_response_due IS NOT NULL AND ts.first_response_due < ?) OR
                    (ts.resolution_at IS NULL AND ts.resolution_due IS NOT NULL AND ts.resolution_due < ?) OR
                    (t.deadline IS NOT NULL AND t.deadline < ?)
                )${ticketPeriod.clause}
                ORDER BY COALESCE(t.deadline, ts.resolution_due, ts.first_response_due) ASC
                LIMIT 10`, [nowIso, nowIso, nowIso, ...ticketPeriod.params]),
            dbAll(`SELECT t.id, t.title, t.priority, t.status, t.created_at, s.name AS system_name, st.name AS assigned_name,
                    ROUND((julianday('now') - julianday(t.created_at)) * 24 * 60, 0) AS age_minutes
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                LEFT JOIN staff st ON t.assigned_to = st.id
                WHERE t.status != 'geschlossen'${ticketPeriod.clause}
                ORDER BY t.created_at ASC
                LIMIT 10`, ticketPeriod.params),
            dbAll(`SELECT COALESCE(NULLIF(TRIM(username), ''), 'Unbekannt') AS name, COUNT(*) AS total
                FROM tickets
                WHERE 1=1${ticketPeriodRaw.clause}
                GROUP BY COALESCE(NULLIF(TRIM(username), ''), 'Unbekannt')
                ORDER BY total DESC
                LIMIT 8`, ticketPeriodRaw.params)
        ]);

        const responseRate = slaOverview.responses_done ? Math.round((slaOverview.responses_in_time || 0) / slaOverview.responses_done * 100) : 0;
        const resolutionRate = slaOverview.resolutions_done ? Math.round((slaOverview.resolutions_in_time || 0) / slaOverview.resolutions_done * 100) : 0;
        const closedRate = totals.total ? Math.round((totals.closed_total || 0) / totals.total * 100) : 0;

        res.render('stats', {
            user: req.session.user,
            role: req.session.role || 'user',
            selectedPeriod,
            totals,
            byStatus,
            byPriority,
            bySystem,
            byStaff,
            responseStats,
            slaOverview: {
                ...slaOverview,
                responseRate,
                resolutionRate
            },
            feedbackStats,
            weeklyTrend: weeklyTrend.reverse(),
            monthlyTrend: monthlyTrend.reverse(),
            yearlyTrend: yearlyTrend.reverse(),
            agingBuckets,
            unassignedTickets,
            overdueSlaTickets,
            longestOpenTickets,
            busiestCreators,
            closedRate,
            formatMinutes
        });
    } catch (err) {
        console.error('Stats Error:', err.message);
        res.status(500).send('Statistiken konnten nicht geladen werden.');
    }
});

app.get('/stats/tokens', requireAuth, requireAdmin, (req, res) => {
    const allowedPeriods = new Set(['daily', 'monthly', 'yearly', 'all']);
    const selectedPeriod = allowedPeriods.has(String(req.query.period || 'all')) ? String(req.query.period || 'all') : 'all';

    function buildPeriodFilter(period, column) {
        if (period === 'daily') return { clause: ` AND date(${column}) = date('now')`, params: [] };
        if (period === 'monthly') return { clause: ` AND date(${column}) >= date('now', 'start of month')`, params: [] };
        if (period === 'yearly') return { clause: ` AND date(${column}) >= date('now', 'start of year')`, params: [] };
        return { clause: '', params: [] };
    }

    const tokenPeriod = buildPeriodFilter(selectedPeriod, 'created_at');
    const subscriptionProviders = ['ollama', 'copilot'];

    function normalizeModelName(model) {
        return String(model || '').trim().toLowerCase();
    }

    function getPricing(provider, model) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const normalizedModel = normalizeModelName(model);

        if (normalizedProvider === 'openai_local' || normalizedProvider === 'mistral') {
            return { kind: 'free', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'Kostenloser Provider' };
        }
        if (normalizedProvider === 'openrouter') {
            if (normalizedModel.includes('lin 2.6') || normalizedModel.includes('lin-2.6') || normalizedModel.includes('lin/2.6') || normalizedModel.includes('lin-2.6:free') || normalizedModel.includes('lin 2.6 free')) {
                return { kind: 'free', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'OpenRouter Lin 2.6 (kostenlos)' };
            }
            if (normalizedModel.includes(':free') || normalizedModel.endsWith('/free')) {
                return { kind: 'free', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'OpenRouter Free-Modell' };
            }
            return { kind: 'unknown', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'OpenRouter-Modell ohne hinterlegten Preis' };
        }
        if (normalizedProvider === 'ollama') {
            return { kind: 'subscription', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'Monatsabo 20 EUR' };
        }
        if (normalizedProvider === 'copilot') {
            return { kind: 'subscription', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'Monatsabo 40 EUR' };
        }
        if (normalizedProvider === 'deepseek') {
            if (normalizedModel.includes('v4-pro')) return { kind: 'metered', inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87, label: 'DeepSeek V4 Pro, aktueller Discountpreis' };
            return { kind: 'metered', inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28, label: 'DeepSeek Chat/Flash, aktueller Preis' };
        }
        if (normalizedProvider === 'openai') {
            if (normalizedModel.includes('gpt-5.5-pro')) return { kind: 'metered', inputUsdPerMillion: 30, outputUsdPerMillion: 180, label: 'OpenAI GPT-5.5 Pro' };
            if (normalizedModel.includes('gpt-5.5')) return { kind: 'metered', inputUsdPerMillion: 5, outputUsdPerMillion: 30, label: 'OpenAI GPT-5.5' };
            if (normalizedModel.includes('gpt-5.4-pro')) return { kind: 'metered', inputUsdPerMillion: 30, outputUsdPerMillion: 180, label: 'OpenAI GPT-5.4 Pro' };
            if (normalizedModel.includes('gpt-5.4-mini')) return { kind: 'metered', inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, label: 'OpenAI GPT-5.4 Mini' };
            if (normalizedModel.includes('gpt-5.4-nano')) return { kind: 'metered', inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.25, label: 'OpenAI GPT-5.4 Nano' };
            if (normalizedModel.includes('gpt-5.4') || normalizedModel === 'gpt-5') return { kind: 'metered', inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, label: 'OpenAI GPT-5.4' };
            if (normalizedModel.includes('gpt-4.1-mini')) return { kind: 'metered', inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, label: 'OpenAI GPT-4.1 Mini' };
            if (normalizedModel.includes('gpt-4.1-nano')) return { kind: 'metered', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4, label: 'OpenAI GPT-4.1 Nano' };
            if (normalizedModel.includes('gpt-4.1')) return { kind: 'metered', inputUsdPerMillion: 2, outputUsdPerMillion: 8, label: 'OpenAI GPT-4.1' };
            if (normalizedModel.includes('gpt-4o-mini')) return { kind: 'metered', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, label: 'OpenAI GPT-4o Mini' };
            if (normalizedModel.includes('gpt-4o')) return { kind: 'metered', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10, label: 'OpenAI GPT-4o' };
        }
        if (normalizedProvider === 'anthropic') {
            if (normalizedModel.includes('opus')) return { kind: 'metered', inputUsdPerMillion: 15, outputUsdPerMillion: 30, label: 'Anthropic Claude Opus' };
            if (normalizedModel.includes('haiku 4.5') || normalizedModel.includes('haiku-4.5')) return { kind: 'metered', inputUsdPerMillion: 1, outputUsdPerMillion: 2, label: 'Anthropic Claude Haiku 4.5' };
            if (normalizedModel.includes('haiku 3.5') || normalizedModel.includes('haiku-3.5')) return { kind: 'metered', inputUsdPerMillion: 0.8, outputUsdPerMillion: 1.6, label: 'Anthropic Claude Haiku 3.5' };
            return { kind: 'metered', inputUsdPerMillion: 3, outputUsdPerMillion: 6, label: 'Anthropic Claude Sonnet' };
        }
        if (normalizedProvider === 'clarifai') {
            if (normalizedModel.includes('kimi')) return { kind: 'metered', inputUsdPerMillion: 1.5, outputUsdPerMillion: 1.5, label: 'Clarifai Kimi' };
            if (normalizedModel.includes('gpt-oss')) return { kind: 'metered', inputUsdPerMillion: 0.09, outputUsdPerMillion: 0.36, label: 'Clarifai GPT OSS 120B' };
            if (normalizedModel.includes('claude-opus')) return { kind: 'metered', inputUsdPerMillion: 6.25, outputUsdPerMillion: 31.25, label: 'Clarifai Claude Opus 4.5' };
            if (normalizedModel.includes('gpt-5')) return { kind: 'metered', inputUsdPerMillion: 1.5625, outputUsdPerMillion: 12.5, label: 'Clarifai GPT-5.1' };
            if (normalizedModel.includes('qwen3-coder')) return { kind: 'metered', inputUsdPerMillion: 0.36, outputUsdPerMillion: 1.3, label: 'Clarifai Qwen3 Coder' };
        }

        return { kind: 'unknown', inputUsdPerMillion: 0, outputUsdPerMillion: 0, label: 'Kein Preis hinterlegt' };
    }

    function estimateVariableCostUsd(provider, model, promptTokens, completionTokens) {
        const pricing = getPricing(provider, model);
        const estimatedCostUsd = ((promptTokens || 0) * pricing.inputUsdPerMillion + (completionTokens || 0) * pricing.outputUsdPerMillion) / 1000000;
        return {
            pricing,
            estimatedCostUsd
        };
    }

    function countMonthsInclusive(startDate, endDate) {
        if (!startDate || !endDate) return 0;
        return ((endDate.getFullYear() - startDate.getFullYear()) * 12) + (endDate.getMonth() - startDate.getMonth()) + 1;
    }

    function estimateSubscriptionCostEur(provider, period, statsStartedAt) {
        const monthlyFee = provider === 'ollama' ? 20 : provider === 'copilot' ? 40 : 0;
        if (!monthlyFee) return 0;
        const now = new Date();
        if (period === 'daily') {
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            return monthlyFee / daysInMonth;
        }
        if (period === 'monthly') return monthlyFee;
        if (period === 'yearly') return monthlyFee * (now.getMonth() + 1);
        if (!statsStartedAt) return 0;
        return monthlyFee * countMonthsInclusive(statsStartedAt, now);
    }

    const query = `
        SELECT provider, model,
               SUM(prompt_tokens) as total_prompt,
               SUM(completion_tokens) as total_completion,
               COUNT(*) as call_count,
               SUM(duration_ms) as total_duration_ms
        FROM ai_token_usage
        WHERE 1=1${tokenPeriod.clause}
        GROUP BY provider, model
        ORDER BY total_prompt + total_completion DESC
    `;
    const summaryQuery = `
        SELECT provider,
               SUM(prompt_tokens) as total_prompt,
               SUM(completion_tokens) as total_completion,
               COUNT(*) as call_count,
               SUM(duration_ms) as total_duration_ms
        FROM ai_token_usage
        WHERE 1=1${tokenPeriod.clause}
        GROUP BY provider
        ORDER BY total_prompt + total_completion DESC
    `;
    const statsStartQuery = `
        SELECT MIN(created_at) AS stats_started_at
        FROM ai_token_usage
    `;
    db.all(query, tokenPeriod.params, (err, byModel) => {
        if (err) { console.error('Token stats error:', err.message); return res.status(500).send('Fehler beim Laden der Token-Statistiken.'); }
        db.all(summaryQuery, tokenPeriod.params, (err2, byProvider) => {
            if (err2) { console.error('Token stats summary error:', err2.message); return res.status(500).send('Fehler beim Laden der Token-Statistiken.'); }
            db.get(statsStartQuery, [], (err3, statsStartRow) => {
                if (err3) { console.error('Token stats subscription error:', err3.message); return res.status(500).send('Fehler beim Laden der Token-Statistiken.'); }

                const statsStartedAt = statsStartRow && statsStartRow.stats_started_at ? new Date(statsStartRow.stats_started_at) : null;

                let grandTotal = 0;
                let variableCostUsdTotal = 0;
                let unknownCostRows = 0;
                const byModelDetailed = (byModel || []).map(row => {
                    const totalTokens = (row.total_prompt || 0) + (row.total_completion || 0);
                    const { pricing, estimatedCostUsd } = estimateVariableCostUsd(row.provider, row.model, row.total_prompt || 0, row.total_completion || 0);
                    grandTotal += totalTokens;
                    variableCostUsdTotal += estimatedCostUsd;
                    if (pricing.kind === 'unknown') unknownCostRows += 1;
                    return {
                        ...row,
                        total_tokens: totalTokens,
                        estimated_cost_usd: estimatedCostUsd,
                        pricing_kind: pricing.kind,
                        pricing_label: pricing.label,
                        input_price_usd_per_million: pricing.inputUsdPerMillion,
                        output_price_usd_per_million: pricing.outputUsdPerMillion
                    };
                });

                const variableCostByProvider = new Map();
                byModelDetailed.forEach(row => {
                    variableCostByProvider.set(row.provider, (variableCostByProvider.get(row.provider) || 0) + (row.estimated_cost_usd || 0));
                });

                const providerRows = new Map();
                (byProvider || []).forEach(row => {
                    providerRows.set(row.provider, {
                        ...row,
                        total_tokens: (row.total_prompt || 0) + (row.total_completion || 0),
                        estimated_cost_usd: variableCostByProvider.get(row.provider) || 0,
                        subscription_cost_eur: 0
                    });
                });

                subscriptionProviders.forEach(provider => {
                    if (!providerRows.has(provider)) {
                        providerRows.set(provider, {
                            provider,
                            total_prompt: 0,
                            total_completion: 0,
                            call_count: 0,
                            total_duration_ms: 0,
                            total_tokens: 0,
                            estimated_cost_usd: 0,
                            subscription_cost_eur: 0
                        });
                    }
                });

                let subscriptionCostEurTotal = 0;
                const byProviderDetailed = Array.from(providerRows.values()).map(row => {
                    const subscriptionCostEur = estimateSubscriptionCostEur(row.provider, selectedPeriod, statsStartedAt);
                    subscriptionCostEurTotal += subscriptionCostEur;
                    return {
                        ...row,
                        subscription_cost_eur: subscriptionCostEur
                    };
                }).sort((left, right) => {
                    const leftCombined = (left.estimated_cost_usd || 0) + (left.subscription_cost_eur || 0);
                    const rightCombined = (right.estimated_cost_usd || 0) + (right.subscription_cost_eur || 0);
                    if (rightCombined !== leftCombined) return rightCombined - leftCombined;
                    return String(left.provider || '').localeCompare(String(right.provider || ''));
                });

                const statsStartLabel = statsStartedAt
                    ? statsStartedAt.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' })
                    : null;

                let subscriptionCostBasis = 'Monatskosten fuer den gewaehlten Zeitraum';
                if (selectedPeriod === 'daily') subscriptionCostBasis = 'Tagesanteil der Monatsabos';
                else if (selectedPeriod === 'monthly') subscriptionCostBasis = 'Monatsabos fuer den aktuellen Monat';
                else if (selectedPeriod === 'yearly') subscriptionCostBasis = 'Aufsummierte Monatsabos seit Jahresbeginn';
                else if (selectedPeriod === 'all') subscriptionCostBasis = statsStartLabel
                    ? `Aufsummierte Monatsabos seit Statistikbeginn am ${statsStartLabel}`
                    : 'Keine Statistikbasis fuer Abo-Kosten vorhanden';

                res.render('stats-tokens', {
                    user: req.session.user,
                    role: req.session.role || 'user',
                    selectedPeriod,
                    byModel: byModelDetailed,
                    byProvider: byProviderDetailed,
                    grandTotal,
                    variableCostUsdTotal,
                    subscriptionCostEurTotal,
                    unknownCostRows,
                    subscriptionCostBasis
                });
            });
        });
    });
});

// --- Web UI: Dashboard & Detail ---

app.get('/', requireAuth, (req, res) => {
    const user = req.session.user;
    const role = req.session.role || 'user';
    const staffId = req.session.staff_id;
    const myTickets = req.query.my_tickets === '1' && staffId;
    const view = ['unassigned', 'overdue', 'critical', 'waiting'].includes(req.query.view) ? req.query.view : null;
    const now = new Date().toISOString();

    let ticketQuery = `SELECT t.*, s.name as system_name, st.name as assigned_name 
        FROM tickets t 
        LEFT JOIN systems s ON t.system_id = s.id 
        LEFT JOIN staff st ON t.assigned_to = st.id`;
    const ticketParams = [];
    const visibility = ticketVisibilityClause(req, 't');
    let hasWhere = false;
    if (visibility.clause) {
        ticketQuery += ' WHERE ' + visibility.clause.replace(/^ AND /, '');
        ticketParams.push(...visibility.params);
        hasWhere = true;
    }
    if (myTickets) {
        ticketQuery += hasWhere ? ' AND t.assigned_to = ?' : ' WHERE t.assigned_to = ?';
        ticketParams.push(staffId);
        hasWhere = true;
    }
    if (view === 'unassigned') {
        ticketQuery += hasWhere ? ' AND t.assigned_to IS NULL AND t.status != ?' : ' WHERE t.assigned_to IS NULL AND t.status != ?';
        ticketParams.push('geschlossen');
        hasWhere = true;
    } else if (view === 'overdue') {
        ticketQuery += hasWhere ? ' AND t.status != ? AND t.deadline < ?' : ' WHERE t.status != ? AND t.deadline < ?';
        ticketParams.push('geschlossen', now);
        hasWhere = true;
    } else if (view === 'critical') {
        ticketQuery += hasWhere ? ' AND t.priority = ? AND t.status != ?' : ' WHERE t.priority = ? AND t.status != ?';
        ticketParams.push('kritisch', 'geschlossen');
        hasWhere = true;
    } else if (view === 'waiting') {
        ticketQuery += hasWhere ? ' AND t.status = ?' : ' WHERE t.status = ?';
        ticketParams.push('wartend');
        hasWhere = true;
    }
    ticketQuery += ' ORDER BY t.updated_at DESC';

    // Alle Tickets laden
    db.all(ticketQuery, ticketParams, (err, tickets) => {
        if (err) {
            console.error('Fehler beim Laden der Tickets:', err);
            tickets = [];
        }
        if (!tickets) tickets = [];

        // Stats
        const statsVisibility = ticketVisibilityClause(req, 't');
        db.all(`SELECT status, COUNT(*) as count FROM tickets t WHERE 1=1${statsVisibility.clause} GROUP BY status`, statsVisibility.params, (err, stats) => {
            if (err) stats = [];

            // Overdue tickets
            db.all(`SELECT t.*, s.name as system_name FROM tickets t 
                LEFT JOIN systems s ON t.system_id = s.id 
                WHERE t.status != 'geschlossen' AND t.deadline < ?${statsVisibility.clause} ORDER BY t.deadline ASC`, [now, ...statsVisibility.params], (err, overdue) => {
                if (err) overdue = [];

                // Due soon (next 2 hours)
                const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
                db.all(`SELECT t.*, s.name as system_name FROM tickets t 
                    LEFT JOIN systems s ON t.system_id = s.id 
                    WHERE t.status != 'geschlossen' AND t.deadline BETWEEN ? AND ?${statsVisibility.clause} ORDER BY t.deadline ASC`, [now, soon, ...statsVisibility.params], (err, dueSoon) => {
                    if (err) dueSoon = [];

                    // SLA Stats
                    db.get(`SELECT 
                        COUNT(CASE WHEN first_response_breached = 1 THEN 1 END) as fr_breached,
                        COUNT(CASE WHEN resolution_breached = 1 THEN 1 END) as res_breached,
                        COUNT(*) as total FROM ticket_sla ts
                        INNER JOIN tickets t ON t.id = ts.ticket_id
                        WHERE 1=1${statsVisibility.clause}`, statsVisibility.params, (err, slaStats) => {
                        
                        // Feedback Stats
                        getAverageFeedback((err, feedbackStats) => {
                            
                            // Recent activity
                            const activitySql = canManageTickets(req)
                                ? `SELECT a.*, t.title as ticket_title FROM activity_stream a 
                                LEFT JOIN tickets t ON a.ticket_id = t.id 
                                ORDER BY a.created_at DESC LIMIT 10`
                                : `SELECT a.*, t.title as ticket_title FROM activity_stream a 
                                LEFT JOIN tickets t ON a.ticket_id = t.id 
                                WHERE 1=1${statsVisibility.clause}
                                ORDER BY a.created_at DESC LIMIT 10`;
                            const activityParams = canManageTickets(req) ? [] : statsVisibility.params;
                            db.all(activitySql, activityParams, (err, recentActivity) => {
                                if (err) recentActivity = [];

                                db.all('SELECT ticket_id FROM ticket_pins WHERE username = ?', [user], (err, pins) => {
                                    const pinnedIds = pins ? pins.map(p => p.ticket_id) : [];

                                res.render('dashboard', { 
                                    user, 
                                    role,
                                    staffId,
                                    myTickets: !!myTickets,
                                    view,
                                    tickets: tickets.map(enrichTicket),
                                    stats, 
                                    overdue: overdue.map(enrichTicket), 
                                    dueSoon: dueSoon.map(enrichTicket),
                                    slaStats: slaStats || { fr_breached: 0, res_breached: 0, total: 0 },
                                    feedbackStats: feedbackStats || { avg_rating: 0, count: 0 },
                                    recentActivity: recentActivity.map(a => ({ ...a, metadata: a.metadata ? JSON.parse(a.metadata) : {} })),
                                    pinnedIds
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});
});

app.get('/ticket/new', requireAuth, (req, res) => {
    db.all('SELECT * FROM systems WHERE active = 1', [], (err, systems) => {
        db.all('SELECT * FROM ticket_templates WHERE active = 1', [], (err, templates) => {
            db.all('SELECT * FROM staff', [], (err, staff) => {
                res.render('new', {
                    systems: systems || [],
                    templates: templates || [],
                    staffList: canManageTickets(req) ? (staff || []) : [],
                    user: req.session.user,
                    role: req.session.role || 'user',
                    canManageTickets: canManageTickets(req)
                });
            });
        });
    });
});

app.get('/ticket/:id', requireAuth, (req, res) => {
    const ticketId = req.params.id;
    const user = req.session.user;
    const role = req.session.role || 'user';

    db.get(`SELECT t.*, s.name as system_name, st.name as assigned_name, st.email as assigned_email
        FROM tickets t 
        LEFT JOIN systems s ON t.system_id = s.id 
        LEFT JOIN staff st ON t.assigned_to = st.id 
        WHERE t.id = ?`, [ticketId], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Ticket nicht gefunden');
        if (!canViewTicket(req, ticket)) return res.status(403).send('Keine Berechtigung.');

        const canManage = canManageTickets(req);
        const noteQuery = canManage
            ? 'SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at DESC'
            : 'SELECT * FROM ticket_notes WHERE ticket_id = ? AND is_internal = 0 ORDER BY created_at DESC';

        db.all(noteQuery, [ticketId], (err, notes) => {
            db.all(canManage ? 'SELECT * FROM audit_log WHERE ticket_id = ? ORDER BY created_at DESC' : 'SELECT * FROM audit_log WHERE 1=0', [ticketId], (err, logs) => {
                db.all('SELECT * FROM systems WHERE active = 1', [], (err, systems) => {
                    db.all('SELECT * FROM staff WHERE active = 1', [], (err, staffList) => {
                        getSLAStatus(ticketId, (sla) => {
                            const renderDetail = (activities) => {
                                getFeedback(ticketId, (err, feedback) => {
                                    res.render('detail', { 
                                        ticket: enrichTicket(ticket), 
                                        notes: notes || [], 
                                        logs: logs || [], 
                                        systems: systems || [], 
                                        staffList: canManage ? (staffList || []) : [],
                                        sla: sla || {},
                                        activities: canManage ? (activities || []) : [],
                                        feedback: feedback || null,
                                        externalDispatchPrompt: buildExternalDispatchPrompt,
                                        externalDispatchPromptTemplate: EXTERNAL_DISPATCH_PROMPT_TEMPLATE,
                                        externalDispatchPromptBranchToken: EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN,
                                        user,
                                        role,
                                        canManageTickets: canManage
                                    });
                                });
                            };
                            if (canManage) getActivities(ticketId, renderDetail);
                            else renderDetail([]);
                        });
                    });
                });
            });
        });
    });
});

app.post('/ticket/:id/delete', requireAuth, requireAdmin, (req, res) => {
    const ticketId = req.params.id;
    const actor = getActor(req);
    logAction(ticketId, actor, 'deleted', 'Ticket endgültig gelöscht');
    db.run('DELETE FROM tickets WHERE id = ?', [ticketId], function(err) {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/');
    });
});

app.post('/ticket/:id/status', requireAuth, requireAdmin, (req, res) => {
    const { status } = req.body;
    const ticketId = req.params.id;
    const actor = getActor(req);
    
    if (!['offen', 'in_bearbeitung', 'wartend', 'umgesetzt', 'geschlossen'].includes(status)) {
        return res.status(400).send('Ungueltiger Status');
    }
    
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
        if (err || !oldTicket) return res.status(404).send('Ticket nicht gefunden');
        
        const updates = { status };
        if (status === 'geschlossen') {
            updates.closed_at = new Date().toISOString();
            updates.feedback_requested = 0;
        } else if (oldTicket.status === 'geschlossen') {
            updates.closed_at = null;
            updates.feedback_requested = 0;
        }

        const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), ticketId];

        db.run(`UPDATE tickets SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values, function(err) {
            if (err) return res.status(500).send('DB Error');
            
            logAction(ticketId, actor, 'status_change', `Status: ${oldTicket.status} → ${status}`);
            addActivity(ticketId, actor, 'status_changed', `Status geändert: ${oldTicket.status} → ${status}`, { old: oldTicket.status, new: status });
            
            mailStatusChange({ ...oldTicket, status }, oldTicket.status);

            if (status === 'geschlossen') {
                updateSLAResolution(ticketId);
                addActivity(ticketId, actor, 'closed', 'Ticket geschlossen', {});
            }

            io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates: { status }, actor });
            res.redirect(status === 'geschlossen' ? '/' : '/ticket/' + ticketId);
        });
    });
});

app.post('/tickets/:id/verify', requireAuth, (req, res) => {
    if (!canManageTickets(req)) return res.status(403).json({ error: 'Keine Berechtigung.' });
    const ticketId = req.params.id;
    const actor = getActor(req);

    workflowEngine.markTicketUeberprueft(ticketId, actor).then(ok => {
        if (!ok) return res.status(409).json({ error: 'Verifizierung nicht moeglich - Ticket nicht im Status "umgesetzt".' });
        db.get('SELECT status FROM tickets WHERE id = ?', [ticketId], (err, row) => {
            if (err) return res.status(500).json({ error: 'DB-Fehler' });
            logAction(ticketId, actor, 'verify', `Status: umgesetzt → überprüft (Verifizierung)`);
            addActivity(ticketId, actor, 'verified', 'Ticket verifiziert', { from: 'umgesetzt', to: 'überprüft' });
            io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates: { status: 'überprüft' }, actor });
            res.json({ success: true });
        });
    }).catch(err => {
        console.error('[verify] Error:', err.message);
        res.status(500).json({ error: 'Verifizierung fehlgeschlagen.' });
    });
});

// Merge-Endpunkt: Nur für Approver oder Admins verfügbar
// Setzt den Ticketstatus automatisch auf "geschlossen" nach erfolgreichem Merge
app.post('/ticket/:id/merge', requireAuth, (req, res) => {
    const ticketId = req.params.id;
    const actor = getActor(req);
    const staffId = req.session.staff_id;

    // Prüfe ob User die Rolle "approval" hat oder Admin ist
    if (req.session.role !== 'admin' && req.session.role !== 'root') {
        // Prüfe Staff-Rollen auf "approval"
        if (!staffId) return res.status(403).json({ error: 'Keine Berechtigung zum Mergen' });
        
        db.get(`SELECT sr.role FROM staff_roles sr WHERE sr.staff_id = ? AND sr.role = 'approval' AND sr.active = 1`,
            [staffId], (err, roleRow) => {
            if (err || !roleRow) {
                return res.status(403).json({ error: 'Nur Approver dürfen mergen' });
            }
            performMerge(ticketId, actor);
        });
    } else {
        performMerge(ticketId, actor);
    }

    function performMerge(ticketId, actor) {
        db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
            if (err || !oldTicket) return res.status(404).json({ error: 'Ticket nicht gefunden' });

            // Update: merge_review auf 'merged', Status auf 'geschlossen'
            const now = new Date().toISOString();
            const updates = {
                merge_review: 'merged',
                status: 'geschlossen',
                closed_at: now
            };

            db.run(`UPDATE tickets SET merge_review = ?, status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [updates.merge_review, updates.status, updates.closed_at, ticketId],
                function(err) {
                    if (err) return res.status(500).json({ error: 'DB Error: ' + err.message });
                    
                    logAction(ticketId, actor, 'merge', `Merge durchgeführt durch Approver`);
                    addActivity(ticketId, actor, 'merged', `Merge durchgeführt und Ticket geschlossen`, 
                        { old_status: oldTicket.status, new_status: 'geschlossen', merge_review: 'merged' });
                    
                    // Update SLA bei Abschluss
                    updateSLAResolution(ticketId);
                    
                    // Feedback anfragen
                    db.run('UPDATE tickets SET feedback_requested = 1 WHERE id = ?', [ticketId]);
                    
                    // Benachrichtigungen senden
    db.get('SELECT t.*, s.name as system_name, s.repo_owner, s.repo_name FROM tickets t LEFT JOIN systems s ON t.system_id = s.id WHERE t.id = ?', [ticketId], (err, ticket) => {
                        if (ticket) {
                            mailStatusChange(ticket, oldTicket.status);
                        }
                    });

                    io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates, actor });
                    
                    // JSON-Response oder Redirect
                    if (req.headers['content-type']?.includes('application/json')) {
                        return res.json({ 
                            success: true, 
                            message: 'Merge erfolgreich durchgeführt',
                            ticket: updates
                        });
                    }
                    res.redirect('/ticket/' + ticketId);
                });
        });
    }
});

app.post('/ticket/:id/assign', requireAuth, requireAdmin, (req, res) => {
    const assignedTo = req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
    const systemId = req.body.system_id ? parseInt(req.body.system_id, 10) : null;
    const referenceRepo = parseGithubRepoReference(req.body.reference_repo);
    const ticketId = req.params.id;
    const actor = getActor(req);
    
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
        if (err || !oldTicket) return res.status(404).send('Ticket nicht gefunden');

        const updates = {
            assigned_to: assignedTo,
            system_id: systemId,
            reference_repo_owner: referenceRepo.owner,
            reference_repo_name: referenceRepo.name
        };

        db.run('UPDATE tickets SET assigned_to = ?, system_id = ?, reference_repo_owner = ?, reference_repo_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [assignedTo, systemId, referenceRepo.owner, referenceRepo.name, ticketId], function(err) {
            if (err) return res.status(500).send('DB Error');
            
            const details = buildTicketChangeDetails(oldTicket, updates);
            if (details) logAction(ticketId, actor, 'assignment', details);

            if (assignedTo && assignedTo !== oldTicket.assigned_to) {
                db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
                    if (ticket) {
                        db.get('SELECT * FROM staff WHERE id = ?', [assignedTo], (err, staff) => {
                            if (staff) mailAssigned(ticket, staff);
                        });
                    }
                });
                addActivity(ticketId, actor, 'assigned', `Ticket zugewiesen`, { assigned_to: assignedTo });
            }

            io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates, actor });
            res.redirect('/ticket/' + ticketId);
        });
    });
});

app.post('/ticket/:id/notes', requireAuth, (req, res) => {
    const { text, is_internal = 1 } = req.body;
    const ticketId = req.params.id;
    const actor = getActor(req);

    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (ticketErr, ticket) => {
        if (ticketErr) return res.status(500).send('DB Error');
        if (!ticket) return res.status(404).send('Ticket nicht gefunden');
        if (!canViewTicket(req, ticket)) return res.status(403).send('Keine Berechtigung.');

        const noteIsInternal = canManageTickets(req) ? parseCheckbox(is_internal) : 0;

        db.run('INSERT INTO ticket_notes (ticket_id, author, text, is_internal) VALUES (?, ?, ?, ?)',
        [ticketId, actor, normalizeText(text, 5000), noteIsInternal], function(err) {
            if (err) return res.status(500).send('DB Error');
            
            const noteId = this.lastID;
            logAction(ticketId, actor, 'note_added', `${noteIsInternal ? 'Interne' : 'Öffentliche'} Notiz hinzugefügt`);
            addActivity(ticketId, actor, 'comment', `Kommentar hinzugefügt`, { text: normalizeText(text, 100), is_internal: noteIsInternal });

            io.to(`ticket-${ticketId}`).emit('new-note', {
                ticketId,
                note: { id: noteId, author: actor, text: normalizeText(text, 5000), is_internal: noteIsInternal, created_at: new Date().toISOString() }
            });

            // First Response
            db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
                if (canManageTickets(req) && ticket && !ticket.first_responded_at) {
                    db.run('UPDATE tickets SET first_responded_at = CURRENT_TIMESTAMP WHERE id = ?', [ticketId]);
                    updateSLAFirstResponse(ticketId);
                }
            });

            res.redirect('/ticket/' + ticketId);
        });
    });
});

app.post('/ticket/new', requireAuth, (req, res) => {
    const d = req.body;
    d.title = normalizeText(d.title || 'Unbenannt', 200) || 'Unbenannt';
    d.description = normalizeText(d.description || '', 5000);
    d.username = normalizeText(d.username || req.session.user, 120) || req.session.user;
    d.location = normalizeText(d.location || '', 200) || null;
    d.contact_email = normalizeText(d.contact_email || '', 254) || null;
    if (!canManageTickets(req)) d.assigned_to = null;
    const referenceRepo = parseGithubRepoReference(d.reference_repo, d.reference_repo_owner && d.reference_repo_name ? `${d.reference_repo_owner}/${d.reference_repo_name}` : '');
    let swInfo = d.software_info;
    if (swInfo && typeof swInfo === 'object') swInfo = JSON.stringify(swInfo);

    let deadline = d.deadline ? new Date(d.deadline).toISOString() : null;
    if (!deadline) {
        deadline = calculateDeadline(d.type || 'bug', d.urgency || 'normal', d.priority || 'mittel');
    }

    const stmt = `INSERT INTO tickets (type, title, description, username, console_logs, software_info, status, priority, system_id, assigned_to, location, contact_email, urgency, deadline, reference_repo_owner, reference_repo_name)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const vals = [
        d.type || 'bug', d.title || 'Unbenannt', d.description || '', d.username || null,
        d.console_logs || null, swInfo || null, 'offen', d.priority || 'mittel',
        d.system_id ? parseInt(d.system_id, 10) : null,
        d.assigned_to ? parseInt(d.assigned_to, 10) : null,
        d.location || null, d.contact_email || null, d.urgency || 'normal', deadline,
        referenceRepo.owner, referenceRepo.name
    ];

    db.run(stmt, vals, function(err) {
        if (err) return res.status(500).send('DB Error: ' + err.message);
        const ticketId = this.lastID;
        
        // SLA initialisieren
        initSLA(ticketId, d.priority || 'mittel', new Date().toISOString());
        
        logAction(ticketId, getActor(req), 'created', `Ticket erstellt: ${d.title}${deadline ? ' | Frist bis ' + app.locals.formatDateTime(deadline) : ''}`);
        addActivity(ticketId, getActor(req), 'created', 'Ticket erstellt', { title: d.title, type: d.type });
        
        db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
            if (ticket) mailNewTicket(ticket);
            if (d.assigned_to) {
                db.get('SELECT * FROM staff WHERE id = ?', [d.assigned_to], (err, staff) => {
                    if (staff) mailAssigned(ticket, staff);
                });
            }
        });
        // KI-Workflow asynchron starten
        workflowEngine.startForTicket(ticketId).catch(e => console.error('Workflow-Start (UI):', e.message));
        res.redirect(`/ticket/${ticketId}`);
    });
});

app.post('/ticket/:id/deadline', requireAuth, requireAdmin, (req, res) => {
    const { deadline } = req.body;
    const ticketId = req.params.id;
    const actor = getActor(req);
    const deadlineValue = deadline ? new Date(deadline).toISOString() : null;
    
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
        if (err || !oldTicket) return res.status(404).send('Ticket nicht gefunden');
        
        db.run('UPDATE tickets SET deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
            [deadlineValue, ticketId], function(err) {
            if (err) return res.status(500).send('DB Error');
            
            const oldDeadline = oldTicket.deadline ? app.locals.formatDateTime(oldTicket.deadline) : 'keine';
            const newDeadline = deadlineValue ? app.locals.formatDateTime(deadlineValue) : 'keine';
            logAction(ticketId, actor, 'deadline_change', `Deadline geändert: ${oldDeadline} → ${newDeadline}`);
            addActivity(ticketId, actor, 'updated', `Deadline geändert`, { deadline: deadlineValue });

            io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates: { deadline: deadlineValue }, actor });
            res.redirect('/ticket/' + ticketId);
        });
    });
});

// --- Web UI: Projects ---

app.get('/projects', requireAuth, (req, res) => {
    db.all(`
        SELECT p.*, s.name as system_name,
            (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id) as milestone_count,
            (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id AND status = 'completed') as completed_milestones,
            (SELECT COUNT(*) FROM project_key_users WHERE project_id = p.id) as key_user_count
        FROM projects p
        LEFT JOIN systems s ON p.system_id = s.id
        ORDER BY p.status, p.name
    `, [], (err, projects) => {
        if (err) return res.status(500).send('DB Error');
        db.all('SELECT id, name FROM systems WHERE active = 1 ORDER BY name', [], (err2, systems) => {
            db.all('SELECT id, name FROM staff WHERE active = 1 ORDER BY name', [], (err3, staffList) => {
                res.render('projects', {
                    projects: projects || [],
                    systems: systems || [],
                    staffList: staffList || [],
                    user: req.session.user,
                    role: req.session.role || 'user',
                    canManage: isAdminRole(req.session.role)
                });
            });
        });
    });
});

app.get('/project/:id', requireAuth, (req, res) => {
    const projectId = req.params.id;
    db.get(`SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?`,
        [projectId], (err, project) => {
            if (err) return res.status(500).send('DB Error');
            if (!project) return res.status(404).send('Projekt nicht gefunden');

            const now = new Date().toISOString();
            db.all('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, start_date',
                [projectId], (err, milestones) => {
                    db.all(`
                        SELECT k.*, s.name as staff_name, s.email as staff_email, s.phone as staff_phone
                        FROM project_key_users k JOIN staff s ON k.staff_id = s.id
                        WHERE k.project_id = ? ORDER BY k.role, s.name
                    `, [projectId], (err, keyUsers) => {
                        db.all(`SELECT t.*, st.name as assigned_name, s.name as system_name
                            FROM tickets t LEFT JOIN staff st ON t.assigned_to = st.id
                            LEFT JOIN systems s ON t.system_id = s.id
                            WHERE t.system_id = ? AND t.status != 'geschlossen'
                            ORDER BY t.created_at DESC LIMIT 10`,
                            [project.system_id || -1], (err, tickets) => {
                                db.get('SELECT * FROM github_integration WHERE project_id = ?',
                                    [projectId], (err, github) => {
                                        if (github && github.access_token) {
                                            github.access_token = '***';
                                        }
                                        db.all('SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 5',
                                            [projectId], (err, docs) => {
                                                res.render('project-dashboard', {
                                                    project,
                                                    milestones: milestones || [],
                                                    keyUsers: keyUsers || [],
                                                    tickets: tickets || [],
                                                    docs: docs || [],
                                                    github: github || null,
                                                    user: req.session.user,
                                                    role: req.session.role || 'user',
                                                    canManage: isAdminRole(req.session.role)
                                                });
                                            });
                                    });
                            });
                    });
                });
        });
});

app.get('/project/:id/timeline', requireAuth, (req, res) => {
    (async () => {
        try {
            const project = await dbGet(
                'SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
                [req.params.id]
            );
            if (!project.id) return res.status(404).send('Projekt nicht gefunden');

            const milestones = await dbAll(
                'SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, start_date',
                [req.params.id]
            );

            let milestonesWithSteps = milestones || [];
            if (milestonesWithSteps.length) {
                const milestoneIds = milestonesWithSteps.map((milestone) => milestone.id);
                const milestonePlaceholders = milestoneIds.map(() => '?').join(',');
                const steps = await dbAll(
                    `SELECT * FROM milestone_steps WHERE milestone_id IN (${milestonePlaceholders}) ORDER BY date ASC, created_at ASC, id ASC`,
                    milestoneIds
                );

                const serializedSteps = [];
                if (steps.length) {
                    const stepIds = steps.map((step) => step.id);
                    const stepPlaceholders = stepIds.map(() => '?').join(',');
                    const blobs = await dbAll(
                        `SELECT * FROM blobs WHERE step_id IN (${stepPlaceholders}) ORDER BY created_at ASC, id ASC`,
                        stepIds
                    );
                    const blobsByStep = new Map();
                    blobs.forEach((blob) => {
                        const list = blobsByStep.get(blob.step_id) || [];
                        list.push(blob);
                        blobsByStep.set(blob.step_id, list);
                    });
                    steps.forEach((step) => {
                        serializedSteps.push(serializeMilestoneStep(step, blobsByStep.get(step.id) || []));
                    });
                }

                const stepsByMilestone = new Map();
                serializedSteps.forEach((step) => {
                    const list = stepsByMilestone.get(step.milestoneId) || [];
                    list.push(step);
                    stepsByMilestone.set(step.milestoneId, list);
                });

                milestonesWithSteps = milestonesWithSteps.map((milestone) => ({
                    ...milestone,
                    steps: stepsByMilestone.get(milestone.id) || []
                }));
            }

            res.render('project-timeline', {
                project,
                milestones: milestonesWithSteps,
                user: req.session.user,
                role: req.session.role || 'user',
                canManage: isAdminRole(req.session.role)
            });
        } catch (err) {
            res.status(500).send(err.message);
        }
    })();
});

app.get('/project/:id/milestones', requireAuth, (req, res) => {
    db.get('SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
        [req.params.id], (err, project) => {
            if (err || !project) return res.status(404).send('Projekt nicht gefunden');
            db.all('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, start_date',
                [req.params.id], (err, milestones) => {
                    res.render('project-milestones', {
                        project,
                        milestones: milestones || [],
                        user: req.session.user,
                        role: req.session.role || 'user',
                        canManage: isAdminRole(req.session.role)
                    });
                });
        });
});

app.get('/project/:id/keyusers', requireAuth, (req, res) => {
    db.get('SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
        [req.params.id], (err, project) => {
            if (err || !project) return res.status(404).send('Projekt nicht gefunden');
            db.all(`
                SELECT k.*, s.name as staff_name, s.email as staff_email, s.phone as staff_phone
                FROM project_key_users k JOIN staff s ON k.staff_id = s.id
                WHERE k.project_id = ? ORDER BY k.role, s.name
            `, [req.params.id], (err, keyUsers) => {
                db.all('SELECT id, name FROM staff WHERE active = 1 ORDER BY name', [], (err, staffList) => {
                    res.render('project-keyusers', {
                        project,
                        keyUsers: keyUsers || [],
                        staffList: staffList || [],
                        user: req.session.user,
                        role: req.session.role || 'user',
                        canManage: isAdminRole(req.session.role)
                    });
                });
            });
        });
});

app.get('/project/:id/docs', requireAuth, (req, res) => {
    db.get('SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
        [req.params.id], (err, project) => {
            if (err || !project) return res.status(404).send('Projekt nicht gefunden');
            db.all('SELECT * FROM project_documents WHERE project_id = ? ORDER BY sort_order, title',
                [req.params.id], (err, docs) => {
                    res.render('project-docs', {
                        project,
                        docs: docs || [],
                        user: req.session.user,
                        role: req.session.role || 'user',
                        canManage: isAdminRole(req.session.role)
                    });
                });
        });
});

app.get('/project/:id/docs/:slug', requireAuth, (req, res) => {
    db.get('SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
        [req.params.id], (err, project) => {
            if (err || !project) return res.status(404).send('Projekt nicht gefunden');
            db.get('SELECT * FROM project_documents WHERE project_id = ? AND slug = ?',
                [req.params.id, req.params.slug], (err, doc) => {
                    if (err) return res.status(500).send('DB Error');
                    if (!doc) return res.status(404).send('Dokument nicht gefunden');
                    let htmlContent = '';
                    try { htmlContent = marked.parse(doc.content || ''); } catch(e) { htmlContent = doc.content; }
                    res.render('project-doc-view', {
                        project,
                        doc,
                        htmlContent,
                        user: req.session.user,
                        role: req.session.role || 'user',
                        canManage: isAdminRole(req.session.role)
                    });
                });
        });
});

app.get('/project/:id/github', requireAuth, requireAdmin, (req, res) => {
    db.get('SELECT p.*, s.name as system_name FROM projects p LEFT JOIN systems s ON p.system_id = s.id WHERE p.id = ?',
        [req.params.id], (err, project) => {
            if (err || !project) return res.status(404).send('Projekt nicht gefunden');
            db.get('SELECT * FROM github_integration WHERE project_id = ?', [req.params.id], (err, github) => {
                if (github && github.access_token) github.access_token = '***';
                res.render('project-github', {
                    project,
                    github: github || null,
                    baseUrl: process.env.BASE_URL || ('http://localhost:' + (process.env.PORT || 8010)),
                    user: req.session.user,
                    role: req.session.role || 'user',
                    canManage: isAdminRole(req.session.role)
                });
            });
        });
});

// --- Server Start ---

workflowEngine.init({ db, io });
dossierExport.init({ db });

server.listen(PORT, () => {
    console.log('====================================================');
    console.log('  Ticketsystem Server v2.0 läuft auf ' + BASE_URL);
    console.log('====================================================');
    console.log('  Features: SLA-Tracking, Activity Stream, Feedback');
    console.log('  Echtzeit-Updates: Socket.io aktiviert');
    console.log('  E-Mail:     ' + (mailProvider === 'brevo'
        ? 'Aktiv (Brevo API)'
        : transporter
            ? 'Aktiv (SMTP)'
            : 'Inaktiv (kein Mail-Provider konfiguriert)'));
    console.log('====================================================');
});

module.exports = { app, server, io };
