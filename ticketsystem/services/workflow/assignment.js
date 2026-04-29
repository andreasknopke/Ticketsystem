'use strict';

// Round-Robin-Auswahl eines Mitarbeiters fuer eine gegebene Workflow-Rolle.
// Beruecksichtigt staff.kind, stage.executor_kind und (fuer 'coding') das coding_level.

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

    const sql = `SELECT s.* FROM staff_roles sr
        INNER JOIN staff s ON s.id = sr.staff_id
        WHERE sr.role = ? AND sr.active = 1 AND s.active = 1 ${kindFilter} ${levelFilter}
        ORDER BY sr.priority ASC, s.id ASC`;
    db.all(sql, params, (err, rows) => {
        if (err) return callback(err);
        if (!rows || rows.length === 0) return callback(null, null);

        // Cursor-Key: bei coding mit Level pro Level getrennt
        const cursorKey = options.codingLevel ? `${role}:${options.codingLevel}` : role;
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
    });
}

module.exports = { pickStaffForRole };
'use strict';

// Round-Robin-Auswahl eines Mitarbeiters fuer eine gegebene Workflow-Rolle.
// Beruecksichtigt staff.kind und stage.executor_kind.

function pickStaffForRole(db, role, executorKind, callback) {
    let kindFilter = '';
    if (executorKind === 'ai') kindFilter = "AND s.kind = 'ai'";
    else if (executorKind === 'human') kindFilter = "AND s.kind = 'human'";

    const sql = `SELECT s.* FROM staff_roles sr
        INNER JOIN staff s ON s.id = sr.staff_id
        WHERE sr.role = ? AND sr.active = 1 AND s.active = 1 ${kindFilter}
        ORDER BY sr.priority ASC, s.id ASC`;
    db.all(sql, [role], (err, rows) => {
        if (err) return callback(err);
        if (!rows || rows.length === 0) return callback(null, null);

        db.get('SELECT last_staff_id FROM workflow_role_cursor WHERE role = ?', [role], (curErr, cursor) => {
            if (curErr) return callback(curErr);
            const last = cursor?.last_staff_id || 0;
            const idx = rows.findIndex(r => r.id > last);
            const chosen = idx >= 0 ? rows[idx] : rows[0];

            db.run(`INSERT INTO workflow_role_cursor (role, last_staff_id, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(role) DO UPDATE SET last_staff_id = excluded.last_staff_id, updated_at = CURRENT_TIMESTAMP`,
                [role, chosen.id], (uErr) => {
                if (uErr) return callback(uErr);
                callback(null, chosen);
            });
        });
    });
}

module.exports = { pickStaffForRole };
