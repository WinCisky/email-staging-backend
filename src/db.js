import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTick } from 'node:timers/promises';

export const PAGE_SIZE = 10;

// Every column except the inbox password, which the client already knows
const PUBLIC_COLUMNS = 'id, username, sender, recipients, subject, content, timestamp, is_read';

// Upper bounds for a single /emails/delta response: clients poll it, so they fetch the rest next time
const DELTA_MAX_ROWS = 50;
const DELTA_MAX_CHARS = 20 * 1024 * 1024;

const PURGE_BATCH_SIZE = 500;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        password TEXT,
        sender TEXT,
        recipients TEXT,
        subject TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_read BOOLEAN DEFAULT 0
    );
`;

const INDEXES = `
    CREATE INDEX IF NOT EXISTS idx_emails_inbox ON emails (username, password, id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_emails_timestamp ON emails (timestamp);
`;

/**
 * Opens (creating/migrating if needed) the SQLite database shared by the SMTP and API processes.
 */
export function openDatabase(dbPath, { log } = {}) {
    const db = new DatabaseSync(dbPath);
    restrictPermissions(dbPath, log);

    db.exec(`
        PRAGMA busy_timeout = 5000;              -- the SMTP and API processes write to the same file
        PRAGMA journal_mode = WAL;               -- readers and the writer don't block each other
        PRAGMA journal_size_limit = 67108864;    -- truncate the WAL file back to 64 MiB after checkpoints
    `);
    migrate(db);

    const statements = {
        insert: db.prepare(
            'INSERT INTO emails (username, password, sender, recipients, subject, content) VALUES (?, ?, ?, ?, ?, ?)',
        ),
        list: db.prepare(
            `SELECT ${PUBLIC_COLUMNS} FROM emails WHERE username = ? AND password = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
        ),
        get: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM emails WHERE id = ? AND username = ? AND password = ?`),
        delta: db.prepare(
            `SELECT ${PUBLIC_COLUMNS} FROM emails WHERE username = ? AND password = ? AND id > ? ORDER BY id ASC LIMIT ${DELTA_MAX_ROWS}`,
        ),
        markRead: db.prepare('UPDATE emails SET is_read = 1 WHERE id = ? AND username = ? AND password = ?'),
        markAllRead: db.prepare(
            'UPDATE emails SET is_read = 1 WHERE username = ? AND password = ? AND is_read IS NOT 1',
        ),
        stats: db.prepare(
            'SELECT COUNT(*) AS totalEmails, MAX(timestamp) AS lastEmailDate FROM emails WHERE username = ? AND password = ?',
        ),
        burn: db.prepare('DELETE FROM emails WHERE username = ? AND password = ?'),
        deleteOne: db.prepare('DELETE FROM emails WHERE id = ? AND username = ? AND password = ?'),
        purge: db.prepare(
            `DELETE FROM emails WHERE id IN (SELECT id FROM emails WHERE timestamp < datetime('now', ?) LIMIT ${PURGE_BATCH_SIZE})`,
        ),
        usedBytes: db.prepare(
            'SELECT (page_count - freelist_count) * page_size AS bytes FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()',
        ),
    };

    return {
        /** @returns {number} id of the stored email */
        insertEmail({ username, password, sender, recipients, subject, content }) {
            const result = statements.insert.run(username, password, sender, recipients, subject, content);
            return Number(result.lastInsertRowid);
        },

        /** Newest first. */
        listEmails(username, password, limit, offset) {
            return statements.list.all(username, password, limit, offset);
        },

        getEmail(username, password, id) {
            return statements.get.get(id, username, password);
        },

        /** Emails newer than `afterId`, oldest first, bounded in count and size. */
        listEmailsAfter(username, password, afterId) {
            const rows = [];
            let chars = 0;
            for (const row of statements.delta.iterate(username, password, afterId)) {
                rows.push(row);
                chars += row.content?.length ?? 0;
                if (chars >= DELTA_MAX_CHARS) break;
            }
            return rows;
        },

        /** @returns {number} matching emails (0 = not found) */
        markRead(username, password, id) {
            return Number(statements.markRead.run(id, username, password).changes);
        },

        /** @returns {number} emails that were unread */
        markAllRead(username, password) {
            return Number(statements.markAllRead.run(username, password).changes);
        },

        inboxStats(username, password) {
            const { totalEmails, lastEmailDate } = statements.stats.get(username, password);
            return { totalEmails, lastEmailDate };
        },

        /** @returns {number} deleted emails */
        burnInbox(username, password) {
            return Number(statements.burn.run(username, password).changes);
        },

        /** Not exposed by the API yet (planned "single email delete"). */
        deleteEmail(username, password, id) {
            return Number(statements.deleteOne.run(id, username, password).changes);
        },

        /** Deletes emails older than `days`, in small batches so the other process is never blocked for long. */
        async purgeOlderThan(days) {
            let total = 0;
            while (db.isOpen) {
                const deleted = Number(statements.purge.run(`-${days} days`).changes);
                total += deleted;
                if (deleted < PURGE_BATCH_SIZE) break;
                await nextTick();
            }
            return total;
        },

        /** Bytes used by stored data (excluding free pages that SQLite will reuse). */
        usedBytes() {
            return Number(statements.usedBytes.get().bytes);
        },

        close() {
            if (db.isOpen) db.close();
        },
    };
}

function migrate(db) {
    // IMMEDIATE: the SMTP and API processes may start (and migrate) at the same time
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(SCHEMA);
        const columns = db.prepare('PRAGMA table_info(emails)').all().map((column) => column.name);
        if (!columns.includes('is_read')) {
            db.exec('ALTER TABLE emails ADD COLUMN is_read BOOLEAN DEFAULT 0');
        }
        db.exec(INDEXES);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

/** Emails and inbox credentials are private: the database must only be readable by its owner. */
function restrictPermissions(dbPath, log) {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
        } catch (err) {
            if (err.code !== 'ENOENT') log?.warn(`Could not restrict permissions of ${file}`, err);
        }
    }
}
