'use strict';

// Round-Robin-Auswahl fuer Workflow-Rollen und systembezogene Ticket-Zustaendigkeit.

function chooseRoundRobin(db, cursorKey, rows, callback) {
    if (!rows || rows.length === 0) return callback(null, null);
    db.get('SELECT last_staff_id FROM workflow_role_cursor WHERE role = ?', [cursorKey], (curErr, cursor) => {
        if (curErr) return callback(curErr);
        const last = cursor?.last_staff_id || 0;
        const idx = rows.findIndex(r => r.id > last);
        const chosen = idx >= 0 ? rows[idx] : rows[0];

        db.run(`INSERT INTO workflow_role_cursor (role, last_staff_id, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(role) DO UPDATE SET last_staff_id = excluded.last_staff_id, updated_at = CURRENT_TIMESTAMP`,
        [cursorKey, chosen.id], (uErr) => {
            if (uErr) return callback(uErr);
            callback(null, chosen);
        });
    });
}

function pickStaffForRole(db, role, executorKind, callback, options) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let kindFilter = '';
    if (executorKind === 'ai') kindFilter = "AND s.kind = 'ai'";
    else if (executorKind === 'human') kindFilter = "AND s.kind = 'human'";

    let levelFilter = '';
    const params = [role];
    if (role === 'coding' && options.codingLevel) {
        levelFilter = 'AND s.coding_level = ?';
        params.push(options.codingLevel);
    }

    if (options.staffId) {
        const exactSql = `SELECT s.* FROM staff_roles sr
            INNER JOIN staff s ON s.id = sr.staff_id
            WHERE sr.role = ? AND sr.active = 1 AND s.active = 1 ${kindFilter} ${levelFilter} AND s.id = ?
            ORDER BY sr.priority ASC, s.id ASC LIMIT 1`;
        db.get(exactSql, [...params, options.staffId], (err, row) => {
            if (err) return callback(err);
            callback(null, row || null);
        });
        return;
    }

    const sql = `SELECT s.* FROM staff_roles sr
        INNER JOIN staff s ON s.id = sr.staff_id
        WHERE sr.role = ? AND sr.active = 1 AND s.active = 1 ${kindFilter} ${levelFilter}
        ORDER BY sr.priority ASC, s.id ASC`;
    db.all(sql, params, (err, rows) => {
        if (err) return callback(err);
        const cursorKey = options.codingLevel ? `${role}:${options.codingLevel}` : role;
        chooseRoundRobin(db, cursorKey, rows || [], callback);
    });
}

function pickTicketAssignee(db, systemId, callback) {
    if (!systemId) return callback(null, null);

    const primarySql = `SELECT s.*
        FROM staff_system_assignments ssa
        INNER JOIN staff s ON s.id = ssa.staff_id
        WHERE ssa.system_id = ?
          AND ssa.active = 1
          AND ssa.is_primary = 1
          AND s.active = 1
          AND s.kind = 'human'
        ORDER BY s.name COLLATE NOCASE ASC, s.id ASC`;

    const fallbackSql = `SELECT s.*
        FROM staff_system_assignments ssa
        INNER JOIN staff s ON s.id = ssa.staff_id
        WHERE ssa.system_id = ?
          AND ssa.active = 1
          AND s.active = 1
          AND s.kind = 'human'
        ORDER BY ssa.is_primary DESC, s.name COLLATE NOCASE ASC, s.id ASC`;

    db.all(primarySql, [systemId], (primaryErr, primaryRows) => {
        if (primaryErr) return callback(primaryErr);
        if (primaryRows && primaryRows.length) {
            return chooseRoundRobin(db, `ticket-owner:${systemId}:primary`, primaryRows, callback);
        }
        db.all(fallbackSql, [systemId], (fallbackErr, fallbackRows) => {
            if (fallbackErr) return callback(fallbackErr);
            chooseRoundRobin(db, `ticket-owner:${systemId}:all`, fallbackRows || [], callback);
        });
    });
}

module.exports = { pickStaffForRole, pickTicketAssignee };
