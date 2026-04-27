require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

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

const EMAIL_NOTIFY_NEW = (process.env.EMAIL_NOTIFY_NEW || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_STATUS = (process.env.EMAIL_NOTIFY_STATUS || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_ASSIGN = (process.env.EMAIL_NOTIFY_ASSIGN || 'true').toLowerCase() === 'true';
const EMAIL_NOTIFY_COMMENT = (process.env.EMAIL_NOTIFY_COMMENT || 'true').toLowerCase() === 'true';

if (!APP_SECRET || ADMIN_USER === undefined || ADMIN_PASS === undefined) {
    console.error('FEHLER: APP_SECRET, ADMIN_USER und ADMIN_PASS muessen in der .env Datei gesetzt sein!');
    process.exit(1);
}

// Middleware
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
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// Hilfsfunktionen fuer EJS
app.locals.toTitle = (str) => {
    if (!str) return '';
    return str.replace(/_/g, ' ').replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
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
        active INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        active INTEGER DEFAULT 1
    )`);

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
            { col: 'feedback_requested', sql: 'ALTER TABLE tickets ADD COLUMN feedback_requested INTEGER DEFAULT 0' }
        ];

        migrations.forEach(m => {
            if (!columns.includes(m.col)) {
                db.run(m.sql, (e) => {
                    if (e) console.error(`Fehler beim Hinzufuegen von ${m.col}:`, e.message);
                });
            }
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
            status TEXT CHECK(status IN ('offen', 'in_bearbeitung', 'wartend', 'geschlossen')) DEFAULT 'offen',
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
            feedback_requested INTEGER DEFAULT 0
        )
    `, (err) => {
        if (err) console.error('Fehler beim Erstellen der tickets-Tabelle:', err.message);
        initDb();
    });
}

initTicketsTable();

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
function initMailer() {
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
    if (!EMAIL_NOTIFY_NEW || !transporter) return;
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
    if (!EMAIL_NOTIFY_STATUS || !transporter) return;
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
    if (!EMAIL_NOTIFY_ASSIGN || !transporter || !staff) return;
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
    if (!EMAIL_NOTIFY_COMMENT || !transporter || !ticket.contact_email || note.is_internal) return;
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

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.redirect('/login?error=Benutzername%20und%20Passwort%20erforderlich');

    // Root user from env
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.authenticated = true;
        req.session.user = username;
        req.session.role = 'root';
        req.session.staff_id = null;
        req.session.default_system_id = null;
        return res.redirect('/');
    }

    // DB users
    db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username], (err, user) => {
        if (err || !user) return res.redirect('/login?error=Ungueltige%20Anmeldedaten');
        if (!verifyPassword(password, user.password_hash)) return res.redirect('/login?error=Ungueltige%20Anmeldedaten');
        req.session.authenticated = true;
        req.session.user = user.username;
        req.session.role = user.role;
        req.session.staff_id = user.staff_id;
        req.session.default_system_id = user.default_system_id;
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// --- API: Systems ---

app.get('/api/systems', requireAuth, (req, res) => {
    db.all('SELECT * FROM systems WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/systems', requireAuth, (req, res) => {
    const { name, description } = req.body;
    db.run('INSERT INTO systems (name, description) VALUES (?, ?)', [name, description],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
});

// --- API: Staff ---

app.get('/api/staff', requireAuth, (req, res) => {
    db.all('SELECT * FROM staff WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/staff/:id', requireAuth, (req, res) => {
    db.get('SELECT * FROM staff WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
        res.json(row);
    });
});

app.post('/api/staff', requireAuth, (req, res) => {
    const { name, email, phone } = req.body;
    db.run('INSERT INTO staff (name, email, phone) VALUES (?, ?, ?)', [name, email, phone],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
});

app.delete('/api/staff/:id', requireAuth, (req, res) => {
    db.run('UPDATE staff SET active = 0 WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'deactivated' });
    });
});

// --- API: Notes ---

app.get('/api/tickets/:id/notes', requireAuth, (req, res) => {
    db.all('SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at DESC', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/tickets/:id/notes', requireAuth, (req, res) => {
    const { text, is_internal = 1 } = req.body;
    const actor = getActor(req);
    
    db.run('INSERT INTO ticket_notes (ticket_id, author, text, is_internal) VALUES (?, ?, ?, ?)',
        [req.params.id, actor, text, is_internal],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const noteId = this.lastID;
            logAction(req.params.id, actor, 'note_added', `${is_internal ? 'Interne' : 'Öffentliche'} Notiz hinzugefügt`);
            addActivity(req.params.id, actor, 'comment', `Kommentar hinzugefügt`, { text: text.substring(0, 100), is_internal });
            
            // Socket.io Broadcast
            io.to(`ticket-${req.params.id}`).emit('new-note', {
                ticketId: req.params.id,
                note: { id: noteId, author: actor, text, is_internal, created_at: new Date().toISOString() }
            });
            
            // E-Mail Benachrichtigung
            db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, ticket) => {
                if (ticket && !is_internal) {
                    mailComment(ticket, { text, is_internal }, actor);
                }
            });
            
            // First Response Tracking
            db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, ticket) => {
                if (ticket && !ticket.first_responded_at) {
                    db.run('UPDATE tickets SET first_responded_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
                    updateSLAFirstResponse(req.params.id);
                }
            });
            
            res.json({ id: noteId });
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

app.post('/api/templates', requireAuth, (req, res) => {
    const { name, type, description, fields } = req.body;
    db.run('INSERT INTO ticket_templates (name, type, description, fields) VALUES (?, ?, ?, ?)',
        [name, type, description, JSON.stringify(fields)],
        function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
});

// --- API: SLA ---

app.get('/api/tickets/:id/sla', requireAuth, (req, res) => {
    getSLAStatus(req.params.id, (sla) => {
        res.json(sla || {});
    });
});

// --- API: Activity Stream ---

app.get('/api/tickets/:id/activities', requireAuth, (req, res) => {
    getActivities(req.params.id, (activities) => {
        res.json(activities);
    });
});

// --- API: Feedback ---

app.get('/api/tickets/:id/feedback', requireAuth, (req, res) => {
    getFeedback(req.params.id, (err, feedback) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(feedback || null);
    });
});

app.post('/api/tickets/:id/feedback', requireAuth, (req, res) => {
    const { rating, comment } = req.body;
    addFeedback(req.params.id, rating, comment, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        addActivity(req.params.id, getActor(req), 'feedback', `Feedback abgegeben: ${rating}/5 Sterne`, { rating, comment });
        res.json(result);
    });
});

app.get('/api/feedback/stats', requireAuth, (req, res) => {
    getAverageFeedback((err, stats) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(stats);
    });
});

// --- API: Tickets ---

app.post('/api/tickets', requireApiKey, (req, res) => {
    const d = req.body;
    let swInfo = d.software_info;
    if (swInfo && typeof swInfo === 'object') swInfo = JSON.stringify(swInfo);
    
    let deadline = d.deadline ? new Date(d.deadline).toISOString() : null;
    if (!deadline) {
        deadline = calculateDeadline(d.type || 'bug', d.urgency || 'normal', d.priority || 'mittel');
    }

    const stmt = `INSERT INTO tickets (type, title, description, username, console_logs, software_info, status, priority, system_id, assigned_to, location, contact_email, urgency, deadline)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const vals = [
        d.type || 'bug', d.title || 'Unbenannt', d.description || '', d.username || null,
        d.console_logs || null, swInfo || null, 'offen', d.priority || 'mittel',
        d.system_id ? parseInt(d.system_id, 10) : null,
        d.assigned_to ? parseInt(d.assigned_to, 10) : null,
        d.location || null, d.contact_email || null, d.urgency || 'normal', deadline
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
        return res.status(201).json({
            id: ticketId,
            status: 'created',
            ticketUrl: `${BASE_URL}/ticket/${ticketId}`,
            apiUrl: `${BASE_URL}/api/tickets/${ticketId}`
        });
    });
});

app.get('/api/tickets', requireAuth, (req, res) => {
    let query = 'SELECT t.*, s.name as system_name, st.name as assigned_name FROM tickets t LEFT JOIN systems s ON t.system_id = s.id LEFT JOIN staff st ON t.assigned_to = st.id WHERE 1=1';
    const params = [];
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
    const query = 'SELECT t.id, t.type, t.title, t.status, t.priority, t.system_name, t.assigned_name, t.created_at FROM tickets t LEFT JOIN systems s ON t.system_id = s.id LEFT JOIN staff st ON t.assigned_to = st.id ORDER BY t.created_at DESC';
    db.all(query, [], (err, rows) => {
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
        const t = enrichTicket({ ...row });
        if (t.software_info) { try { t.software_info = JSON.parse(t.software_info); } catch(e) {} }
        res.json(t);
    });
});

app.patch('/api/tickets/:id', requireAuth, (req, res) => {
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
                if (updates.status && oldTicket && oldTicket.status !== updates.status) mailStatusChange(ticket, oldTicket.status);
                if (updates.assigned_to && (!oldTicket || oldTicket.assigned_to !== updates.assigned_to)) {
                    db.get('SELECT * FROM staff WHERE id = ?', [updates.assigned_to], (err, staff) => {
                        if (!err && staff) mailAssigned(ticket, staff);
                    });
                }
            });
            res.json({ id: req.params.id, status: 'updated' });
        });
    });
});

app.delete('/api/tickets/:id', requireAuth, (req, res) => {
    logAction(req.params.id, getActor(req), 'deleted', `Ticket gelöscht`);
    db.run('DELETE FROM tickets WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Ticket nicht gefunden' });
        res.json({ id: req.params.id, status: 'deleted' });
    });
});

// --- Web UI: Systems ---

app.get('/admin/systems', requireAuth, (req, res) => {
    db.all('SELECT * FROM systems WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).send('DB Error');
        res.render('systems', {
            systems: rows,
            user: req.session.user,
            role: req.session.role || 'user'
        });
    });
});

app.post('/admin/systems', requireAuth, (req, res) => {
    const { name, description } = req.body;
    db.run('INSERT INTO systems (name, description) VALUES (?, ?)', [name, description], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/systems');
    });
});

app.post('/admin/systems/:id/delete', requireAuth, (req, res) => {
    db.run('UPDATE systems SET active = 0 WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/systems');
    });
});

app.get('/admin/staff', requireAuth, requireAdmin, (req, res) => {
    db.all('SELECT * FROM staff WHERE active = 1 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).send('DB Error');
        res.render('staff', { staff: rows, user: req.session.user, role: req.session.role || 'user' });
    });
});

app.post('/admin/staff', requireAuth, requireAdmin, (req, res) => {
    const { name, email, phone } = req.body;
    db.run('INSERT INTO staff (name, email, phone) VALUES (?, ?, ?)', [name, email, phone], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/staff');
    });
});

app.post('/admin/staff/:id/update', requireAuth, requireAdmin, (req, res) => {
    const { name, email, phone } = req.body;
    db.run('UPDATE staff SET name = ?, email = ?, phone = ? WHERE id = ?', [name, email, phone || null, req.params.id], (err) => {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/admin/staff');
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
                FROM tickets`, [nowIso]),
            dbAll(`SELECT status, COUNT(*) AS count FROM tickets GROUP BY status ORDER BY count DESC`),
            dbAll(`SELECT priority, COUNT(*) AS count FROM tickets GROUP BY priority ORDER BY
                CASE priority WHEN 'kritisch' THEN 1 WHEN 'hoch' THEN 2 WHEN 'mittel' THEN 3 WHEN 'niedrig' THEN 4 ELSE 5 END`),
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
                GROUP BY COALESCE(s.name, 'Ohne System')
                ORDER BY total DESC, name ASC`),
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
                GROUP BY COALESCE(st.name, 'Nicht zugewiesen')
                ORDER BY total DESC, name ASC`, [nowIso]),
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
                LEFT JOIN ticket_sla ts ON ts.ticket_id = t.id`),
            dbGet(`SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS responses_done,
                SUM(CASE WHEN resolution_at IS NOT NULL THEN 1 ELSE 0 END) AS resolutions_done,
                SUM(CASE WHEN first_response_at IS NOT NULL AND first_response_due IS NOT NULL AND first_response_at <= first_response_due THEN 1 ELSE 0 END) AS responses_in_time,
                SUM(CASE WHEN resolution_at IS NOT NULL AND resolution_due IS NOT NULL AND resolution_at <= resolution_due THEN 1 ELSE 0 END) AS resolutions_in_time,
                SUM(CASE WHEN first_response_at IS NULL AND first_response_due IS NOT NULL AND first_response_due < ? THEN 1 ELSE 0 END) AS pending_response_breached,
                SUM(CASE WHEN resolution_at IS NULL AND resolution_due IS NOT NULL AND resolution_due < ? THEN 1 ELSE 0 END) AS pending_resolution_breached
                FROM ticket_sla`, [nowIso, nowIso]),
            dbGet(`SELECT ROUND(AVG(rating), 2) AS avg_rating, COUNT(*) AS count FROM ticket_feedback`),
            dbAll(`SELECT strftime('%Y-W%W', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                WHERE created_at >= date('now', '-12 weeks')
                GROUP BY period
                ORDER BY period DESC
                LIMIT 12`),
            dbAll(`SELECT strftime('%Y-%m', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                WHERE created_at >= date('now', '-12 months')
                GROUP BY period
                ORDER BY period DESC
                LIMIT 12`),
            dbAll(`SELECT strftime('%Y', created_at) AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN status = 'geschlossen' THEN 1 ELSE 0 END) AS closed,
                ROUND(AVG(CASE WHEN status = 'geschlossen' AND closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 * 60 END), 0) AS avg_resolution_minutes
                FROM tickets
                GROUP BY period
                ORDER BY period DESC
                LIMIT 5`),
            dbAll(`SELECT bucket, COUNT(*) AS count FROM (
                    SELECT CASE
                        WHEN (julianday('now') - julianday(created_at)) < 1 THEN '< 1 Tag'
                        WHEN (julianday('now') - julianday(created_at)) < 3 THEN '1-3 Tage'
                        WHEN (julianday('now') - julianday(created_at)) < 7 THEN '3-7 Tage'
                        WHEN (julianday('now') - julianday(created_at)) < 14 THEN '7-14 Tage'
                        ELSE '> 14 Tage'
                    END AS bucket
                    FROM tickets
                    WHERE status != 'geschlossen'
                ) grouped
                GROUP BY bucket
                ORDER BY CASE bucket WHEN '< 1 Tag' THEN 1 WHEN '1-3 Tage' THEN 2 WHEN '3-7 Tage' THEN 3 WHEN '7-14 Tage' THEN 4 ELSE 5 END`),
            dbAll(`SELECT t.id, t.title, t.priority, t.status, t.created_at, s.name AS system_name
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                WHERE t.assigned_to IS NULL AND t.status != 'geschlossen'
                ORDER BY t.created_at ASC
                LIMIT 10`),
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
                )
                ORDER BY COALESCE(t.deadline, ts.resolution_due, ts.first_response_due) ASC
                LIMIT 10`, [nowIso, nowIso, nowIso]),
            dbAll(`SELECT t.id, t.title, t.priority, t.status, t.created_at, s.name AS system_name, st.name AS assigned_name,
                    ROUND((julianday('now') - julianday(t.created_at)) * 24 * 60, 0) AS age_minutes
                FROM tickets t
                LEFT JOIN systems s ON t.system_id = s.id
                LEFT JOIN staff st ON t.assigned_to = st.id
                WHERE t.status != 'geschlossen'
                ORDER BY t.created_at ASC
                LIMIT 10`),
            dbAll(`SELECT COALESCE(NULLIF(TRIM(username), ''), 'Unbekannt') AS name, COUNT(*) AS total
                FROM tickets
                GROUP BY COALESCE(NULLIF(TRIM(username), ''), 'Unbekannt')
                ORDER BY total DESC
                LIMIT 8`)
        ]);

        const responseRate = slaOverview.responses_done ? Math.round((slaOverview.responses_in_time || 0) / slaOverview.responses_done * 100) : 0;
        const resolutionRate = slaOverview.resolutions_done ? Math.round((slaOverview.resolutions_in_time || 0) / slaOverview.resolutions_done * 100) : 0;
        const closedRate = totals.total ? Math.round((totals.closed_total || 0) / totals.total * 100) : 0;

        res.render('stats', {
            user: req.session.user,
            role: req.session.role || 'user',
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

// --- Web UI: Dashboard & Detail ---

app.get('/', requireAuth, (req, res) => {
    const user = req.session.user;
    const role = req.session.role || 'user';
    const staffId = req.session.staff_id;
    const myTickets = req.query.my_tickets === '1' && staffId;

    let ticketQuery = `SELECT t.*, s.name as system_name, st.name as assigned_name 
        FROM tickets t 
        LEFT JOIN systems s ON t.system_id = s.id 
        LEFT JOIN staff st ON t.assigned_to = st.id`;
    const ticketParams = [];
    if (myTickets) {
        ticketQuery += ' WHERE t.assigned_to = ?';
        ticketParams.push(staffId);
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
        db.all(`SELECT status, COUNT(*) as count FROM tickets GROUP BY status`, [], (err, stats) => {
            if (err) stats = [];

            // Overdue tickets
            const now = new Date().toISOString();
            db.all(`SELECT t.*, s.name as system_name FROM tickets t 
                LEFT JOIN systems s ON t.system_id = s.id 
                WHERE t.status != 'geschlossen' AND t.deadline < ? ORDER BY t.deadline ASC`, [now], (err, overdue) => {
                if (err) overdue = [];

                // Due soon (next 2 hours)
                const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
                db.all(`SELECT t.*, s.name as system_name FROM tickets t 
                    LEFT JOIN systems s ON t.system_id = s.id 
                    WHERE t.status != 'geschlossen' AND t.deadline BETWEEN ? AND ? ORDER BY t.deadline ASC`, [now, soon], (err, dueSoon) => {
                    if (err) dueSoon = [];

                    // SLA Stats
                    db.get(`SELECT 
                        COUNT(CASE WHEN first_response_breached = 1 THEN 1 END) as fr_breached,
                        COUNT(CASE WHEN resolution_breached = 1 THEN 1 END) as res_breached,
                        COUNT(*) as total FROM ticket_sla`, [], (err, slaStats) => {
                        
                        // Feedback Stats
                        getAverageFeedback((err, feedbackStats) => {
                            
                            // Recent activity
                            db.all(`SELECT a.*, t.title as ticket_title FROM activity_stream a 
                                LEFT JOIN tickets t ON a.ticket_id = t.id 
                                ORDER BY a.created_at DESC LIMIT 10`, [], (err, recentActivity) => {
                                if (err) recentActivity = [];

                                res.render('dashboard', { 
                                    user, 
                                    role,
                                    staffId,
                                    myTickets: !!myTickets,
                                    tickets: tickets.map(enrichTicket),
                                    stats, 
                                    overdue: overdue.map(enrichTicket), 
                                    dueSoon: dueSoon.map(enrichTicket),
                                    slaStats: slaStats || { fr_breached: 0, res_breached: 0, total: 0 },
                                    feedbackStats: feedbackStats || { avg_rating: 0, count: 0 },
                                    recentActivity: recentActivity.map(a => ({ ...a, metadata: a.metadata ? JSON.parse(a.metadata) : {} }))
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
                    staffList: staff || [],
                    user: req.session.user,
                    role: req.session.role || 'user'
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

        db.all('SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at DESC', [ticketId], (err, notes) => {
            db.all('SELECT * FROM audit_log WHERE ticket_id = ? ORDER BY created_at DESC', [ticketId], (err, logs) => {
                db.all('SELECT * FROM systems WHERE active = 1', [], (err, systems) => {
                    db.all('SELECT * FROM staff WHERE active = 1', [], (err, staffList) => {
                        getSLAStatus(ticketId, (sla) => {
                            getActivities(ticketId, (activities) => {
                                getFeedback(ticketId, (err, feedback) => {
                                    res.render('detail', { 
                                        ticket: enrichTicket(ticket), 
                                        notes: notes || [], 
                                        logs: logs || [], 
                                        systems: systems || [], 
                                        staffList: staffList || [],
                                        sla: sla || {},
                                        activities: activities || [],
                                        feedback: feedback || null,
                                        user,
                                        role
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

app.post('/ticket/:id/delete', requireAuth, requireAdmin, (req, res) => {
    const ticketId = req.params.id;
    const actor = getActor(req);
    logAction(ticketId, actor, 'deleted', 'Ticket endgültig gelöscht');
    db.run('DELETE FROM tickets WHERE id = ?', [ticketId], function(err) {
        if (err) return res.status(500).send('DB Error');
        res.redirect('/');
    });
});

app.post('/ticket/:id/status', requireAuth, (req, res) => {
    const { status } = req.body;
    const ticketId = req.params.id;
    const actor = getActor(req);
    
    if (!['offen', 'in_bearbeitung', 'wartend', 'geschlossen'].includes(status)) {
        return res.status(400).send('Ungueltiger Status');
    }
    
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
        if (err || !oldTicket) return res.status(404).send('Ticket nicht gefunden');
        
        const updates = { status };
        if (status === 'geschlossen') {
            updates.closed_at = new Date().toISOString();
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
                
                // Feedback anfragen
                db.run('UPDATE tickets SET feedback_requested = 1 WHERE id = ?', [ticketId]);
            }

            io.to(`ticket-${ticketId}`).emit('ticket-updated', { ticketId, updates: { status }, actor });
            res.redirect('/ticket/' + ticketId);
        });
    });
});

app.post('/ticket/:id/assign', requireAuth, (req, res) => {
    const assignedTo = req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
    const systemId = req.body.system_id ? parseInt(req.body.system_id, 10) : null;
    const ticketId = req.params.id;
    const actor = getActor(req);
    
    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, oldTicket) => {
        if (err || !oldTicket) return res.status(404).send('Ticket nicht gefunden');

        const updates = {
            assigned_to: assignedTo,
            system_id: systemId
        };

        db.run('UPDATE tickets SET assigned_to = ?, system_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
            [assignedTo, systemId, ticketId], function(err) {
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

    db.run('INSERT INTO ticket_notes (ticket_id, author, text, is_internal) VALUES (?, ?, ?, ?)',
        [ticketId, actor, text, is_internal], function(err) {
            if (err) return res.status(500).send('DB Error');
            
            const noteId = this.lastID;
            logAction(ticketId, actor, 'note_added', `${is_internal ? 'Interne' : 'Öffentliche'} Notiz hinzugefügt`);
            addActivity(ticketId, actor, 'comment', `Kommentar hinzugefügt`, { text: text.substring(0, 100), is_internal });

            io.to(`ticket-${ticketId}`).emit('new-note', {
                ticketId,
                note: { id: noteId, author: actor, text, is_internal, created_at: new Date().toISOString() }
            });

            // First Response
            db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, ticket) => {
                if (ticket && !ticket.first_responded_at) {
                    db.run('UPDATE tickets SET first_responded_at = CURRENT_TIMESTAMP WHERE id = ?', [ticketId]);
                    updateSLAFirstResponse(ticketId);
                }
            });

            res.redirect('/ticket/' + ticketId);
        });
});

app.post('/ticket/new', requireAuth, (req, res) => {
    const d = req.body;
    let swInfo = d.software_info;
    if (swInfo && typeof swInfo === 'object') swInfo = JSON.stringify(swInfo);

    let deadline = d.deadline ? new Date(d.deadline).toISOString() : null;
    if (!deadline) {
        deadline = calculateDeadline(d.type || 'bug', d.urgency || 'normal', d.priority || 'mittel');
    }

    const stmt = `INSERT INTO tickets (type, title, description, username, console_logs, software_info, status, priority, system_id, assigned_to, location, contact_email, urgency, deadline)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const vals = [
        d.type || 'bug', d.title || 'Unbenannt', d.description || '', d.username || null,
        d.console_logs || null, swInfo || null, 'offen', d.priority || 'mittel',
        d.system_id ? parseInt(d.system_id, 10) : null,
        d.assigned_to ? parseInt(d.assigned_to, 10) : null,
        d.location || null, d.contact_email || null, d.urgency || 'normal', deadline
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
        res.redirect(`/ticket/${ticketId}`);
    });
});

app.post('/ticket/:id/deadline', requireAuth, (req, res) => {
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

// --- Server Start ---

server.listen(PORT, () => {
    console.log('====================================================');
    console.log('  Ticketsystem Server v2.0 läuft auf ' + BASE_URL);
    console.log('====================================================');
    console.log('  Features: SLA-Tracking, Activity Stream, Feedback');
    console.log('  Echtzeit-Updates: Socket.io aktiviert');
    console.log('  E-Mail:     ' + (transporter ? 'Aktiv' : 'Inaktiv (SMTP nicht konfiguriert)'));
    console.log('====================================================');
});

module.exports = { app, server, io };
